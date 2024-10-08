import type { Membership, Team, UserPermissionRole } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import type { AuthOptions, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { encode, decode } from "next-auth/jwt";
import type { Provider } from "next-auth/providers";
import CredentialsProvider from "next-auth/providers/credentials";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";

import checkLicense from "@calcom/features/ee/common/server/checkLicense";
import createUsersAndConnectToOrg from "@calcom/features/ee/dsync/lib/users/createUsersAndConnectToOrg";
import ImpersonationProvider from "@calcom/features/ee/impersonation/lib/ImpersonationProvider";
import { clientSecretVerifier, hostedCal, isSAMLLoginEnabled } from "@calcom/features/ee/sso/lib/saml";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import { HOSTED_CAL_FEATURES } from "@calcom/lib/constants";
import { ENABLE_PROFILE_SWITCHER, IS_TEAM_BILLING_ENABLED, WEBAPP_URL } from "@calcom/lib/constants";
import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import { isENVDev } from "@calcom/lib/env";
import logger from "@calcom/lib/logger";
import { randomString } from "@calcom/lib/random";
import { safeStringify } from "@calcom/lib/safeStringify";
import { UserRepository } from "@calcom/lib/server/repository/user";
import slugify from "@calcom/lib/slugify";
import prisma from "@calcom/prisma";
import { IdentityProvider, MembershipRole } from "@calcom/prisma/enums";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";

import { ErrorCode } from "./ErrorCode";
import { isPasswordValid } from "./isPasswordValid";
import CalComAdapter from "./next-auth-custom-adapter";
import { verifyPassword } from "./verifyPassword";

const log = logger.getSubLogger({ prefix: ["next-auth-options"] });
const GOOGLE_API_CREDENTIALS = process.env.GOOGLE_API_CREDENTIALS || "{}";
const { client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET } =
  JSON.parse(GOOGLE_API_CREDENTIALS)?.web || {};
const GOOGLE_LOGIN_ENABLED = process.env.GOOGLE_LOGIN_ENABLED === "true";
const IS_GOOGLE_LOGIN_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_LOGIN_ENABLED);
const ORGANIZATIONS_AUTOLINK =
  process.env.ORGANIZATIONS_AUTOLINK === "1" || process.env.ORGANIZATIONS_AUTOLINK === "true";

const usernameSlug = (username: string) => `${slugify(username)}-${randomString(6).toLowerCase()}`;
const getDomainFromEmail = (email: string): string => email.split("@")[1];
const getVerifiedOrganizationByAutoAcceptEmailDomain = async (domain: string) => {
  const existingOrg = await prisma.team.findFirst({
    where: {
      organizationSettings: {
        isOrganizationVerified: true,
        orgAutoAcceptEmail: domain,
      },
    },
    select: {
      id: true,
    },
  });
  return existingOrg?.id;
};
const loginWithTotp = async (email: string) =>
  `/auth/login?totp=${await (await import("./signJwt")).default({ email })}`;

type UserTeams = {
  teams: (Membership & {
    team: Pick<Team, "metadata">;
  })[];
};

export const checkIfUserBelongsToActiveTeam = <T extends UserTeams>(user: T) =>
  user.teams.some((m: { team: { metadata: unknown } }) => {
    if (!IS_TEAM_BILLING_ENABLED) {
      return true;
    }

    const metadata = teamMetadataSchema.safeParse(m.team.metadata);

    return metadata.success && metadata.data?.subscriptionId;
  });

const checkIfUserShouldBelongToOrg = async (idP: IdentityProvider, email: string) => {
  const [orgUsername, apexDomain] = email.split("@");
  if (!ORGANIZATIONS_AUTOLINK || idP !== "GOOGLE") return { orgUsername, orgId: undefined };
  const existingOrg = await prisma.team.findFirst({
    where: {
      organizationSettings: {
        isOrganizationVerified: true,
        orgAutoAcceptEmail: apexDomain,
      },
    },
    select: {
      id: true,
    },
  });
  return { orgUsername, orgId: existingOrg?.id };
};

const providers: Provider[] = [
  CredentialsProvider({
    id: "credentials",
    name: "Cal.com",
    type: "credentials",
    credentials: {
      email: { label: "Email Address", type: "email", placeholder: "john.doe@example.com" },
      password: { label: "Password", type: "password", placeholder: "Your super secure password" },
      totpCode: { label: "Two-factor Code", type: "input", placeholder: "Code from authenticator app" },
      backupCode: { label: "Backup Code", type: "input", placeholder: "Two-factor backup code" },
    },
    async authorize(credentials) {
      if (!credentials) {
        console.error(`For some reason credentials are missing`);
        throw new Error(ErrorCode.InternalServerError);
      }

      const user = await UserRepository.findByEmailAndIncludeProfilesAndPassword({
        email: credentials.email,
      });
      // Don't leak information about it being username or password that is invalid
      if (!user) {
        throw new Error(ErrorCode.IncorrectEmailPassword);
      }

      // Locked users cannot login
      if (user.locked) {
        throw new Error(ErrorCode.UserAccountLocked);
      }

      await checkRateLimitAndThrowError({
        identifier: user.email,
      });

      if (user.identityProvider !== IdentityProvider.CAL && !credentials.totpCode) {
        throw new Error(ErrorCode.ThirdPartyIdentityProviderEnabled);
      }
      if (!user.password?.hash && user.identityProvider == IdentityProvider.CAL) {
        throw new Error(ErrorCode.IncorrectEmailPassword);
      }
      if (!user.password?.hash && user.identityProvider !== IdentityProvider.CAL && !credentials.totpCode) {
        throw new Error(ErrorCode.IncorrectEmailPassword);
      }

      if (user.password?.hash && !credentials.totpCode) {
        if (!user.password?.hash) {
          throw new Error(ErrorCode.IncorrectEmailPassword);
        }
        const isCorrectPassword = await verifyPassword(credentials.password, user.password.hash);
        if (!isCorrectPassword) {
          throw new Error(ErrorCode.IncorrectEmailPassword);
        }
      }

      if (user.twoFactorEnabled && credentials.backupCode) {
        if (!process.env.CALENDSO_ENCRYPTION_KEY) {
          console.error("Missing encryption key; cannot proceed with backup code login.");
          throw new Error(ErrorCode.InternalServerError);
        }

        if (!user.backupCodes) throw new Error(ErrorCode.MissingBackupCodes);

        const backupCodes = JSON.parse(
          symmetricDecrypt(user.backupCodes, process.env.CALENDSO_ENCRYPTION_KEY)
        );

        // check if user-supplied code matches one
        const index = backupCodes.indexOf(credentials.backupCode.replaceAll("-", ""));
        if (index === -1) throw new Error(ErrorCode.IncorrectBackupCode);

        // delete verified backup code and re-encrypt remaining
        backupCodes[index] = null;
        await prisma.user.update({
          where: {
            id: user.id,
          },
          data: {
            backupCodes: symmetricEncrypt(JSON.stringify(backupCodes), process.env.CALENDSO_ENCRYPTION_KEY),
          },
        });
      } else if (user.twoFactorEnabled) {
        if (!credentials.totpCode) {
          throw new Error(ErrorCode.SecondFactorRequired);
        }

        if (!user.twoFactorSecret) {
          console.error(`Two factor is enabled for user ${user.id} but they have no secret`);
          throw new Error(ErrorCode.InternalServerError);
        }

        if (!process.env.CALENDSO_ENCRYPTION_KEY) {
          console.error(`"Missing encryption key; cannot proceed with two factor login."`);
          throw new Error(ErrorCode.InternalServerError);
        }

        const secret = symmetricDecrypt(user.twoFactorSecret, process.env.CALENDSO_ENCRYPTION_KEY);
        if (secret.length !== 32) {
          console.error(
            `Two factor secret decryption failed. Expected key with length 32 but got ${secret.length}`
          );
          throw new Error(ErrorCode.InternalServerError);
        }

        const isValidToken = (await import("@calcom/lib/totp")).totpAuthenticatorCheck(
          credentials.totpCode,
          secret
        );
        if (!isValidToken) {
          throw new Error(ErrorCode.IncorrectTwoFactorCode);
        }
      }
      // Check if the user you are logging into has any active teams
      const hasActiveTeams = checkIfUserBelongsToActiveTeam(user);

      // authentication success- but does it meet the minimum password requirements?
      const validateRole = (role: UserPermissionRole) => {
        // User's role is not "ADMIN"
        if (role !== "ADMIN") return role;
        // User's identity provider is not "CAL"
        if (user.identityProvider !== IdentityProvider.CAL) return role;

        if (process.env.NEXT_PUBLIC_IS_E2E) {
          console.warn("E2E testing is enabled, skipping password and 2FA requirements for Admin");
          return role;
        }

        // User's password is valid and two-factor authentication is enabled
        if (isPasswordValid(credentials.password, false, true) && user.twoFactorEnabled) return role;
        // Code is running in a development environment
        if (isENVDev) return role;
        // By this point it is an ADMIN without valid security conditions
        return "INACTIVE_ADMIN";
      };

      return {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        role: validateRole(user.role),
        belongsToActiveTeam: hasActiveTeams,
        locale: user.locale,
        profile: user.allProfiles[0],
      };
    },
  }),
  ImpersonationProvider,
];

if (IS_GOOGLE_LOGIN_ENABLED) {
  providers.push(
    GoogleProvider({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    })
  );
}

if (isSAMLLoginEnabled) {
  providers.push({
    id: "saml",
    name: "BoxyHQ",
    type: "oauth",
    version: "2.0",
    checks: ["pkce", "state"],
    authorization: {
      url: `${WEBAPP_URL}/api/auth/saml/authorize`,
      params: {
        scope: "",
        response_type: "code",
        provider: "saml",
      },
    },
    token: {
      url: `${WEBAPP_URL}/api/auth/saml/token`,
      params: { grant_type: "authorization_code" },
    },
    userinfo: `${WEBAPP_URL}/api/auth/saml/userinfo`,
    profile: async (profile: {
      id?: number;
      firstName?: string;
      lastName?: string;
      email?: string;
      locale?: string;
    }) => {
      const user = await UserRepository.findByEmailAndIncludeProfilesAndPassword({
        email: profile.email || "",
      });
      if (!user) throw new Error(ErrorCode.UserNotFound);

      const [userProfile] = user.allProfiles;
      return {
        id: profile.id || 0,
        firstName: profile.firstName || "",
        lastName: profile.lastName || "",
        email: profile.email || "",
        name: `${profile.firstName || ""} ${profile.lastName || ""}`.trim(),
        email_verified: true,
        locale: profile.locale,
        profile: userProfile,
      };
    },
    options: {
      clientId: "dummy",
      clientSecret: clientSecretVerifier,
    },
    allowDangerousEmailAccountLinking: true,
  });

  // Idp initiated login
  providers.push(
    CredentialsProvider({
      id: "saml-idp",
      name: "IdP Login",
      credentials: {
        code: {},
      },
      async authorize(credentials) {
        if (!credentials) {
          return null;
        }

        const { code } = credentials;

        if (!code) {
          return null;
        }

        const { oauthController } = await (await import("@calcom/features/ee/sso/lib/jackson")).default();

        // Fetch access token
        const { access_token } = await oauthController.token({
          code,
          grant_type: "authorization_code",
          redirect_uri: `${process.env.NEXTAUTH_URL}`,
          client_id: "dummy",
          client_secret: clientSecretVerifier,
        });

        if (!access_token) {
          return null;
        }
        // Fetch user info
        const userInfo = await oauthController.userInfo(access_token);

        if (!userInfo) {
          return null;
        }

        const { id, firstName, lastName, email } = userInfo;
        let user = !email
          ? undefined
          : await UserRepository.findByEmailAndIncludeProfilesAndPassword({ email });
        if (!user) {
          const hostedCal = Boolean(HOSTED_CAL_FEATURES);
          if (hostedCal && email) {
            const domain = getDomainFromEmail(email);
            const organizationId = await getVerifiedOrganizationByAutoAcceptEmailDomain(domain);
            if (organizationId) {
              const createUsersAndConnectToOrgProps = {
                emailsToCreate: [email],
                organizationId,
                identityProvider: IdentityProvider.SAML,
                identityProviderId: email,
              };
              await createUsersAndConnectToOrg(createUsersAndConnectToOrgProps);
              user = await UserRepository.findByEmailAndIncludeProfilesAndPassword({
                email: email,
              });
            }
          }
          if (!user) throw new Error(ErrorCode.UserNotFound);
        }
        const [userProfile] = user?.allProfiles;
        return {
          id: id as unknown as number,
          firstName,
          lastName,
          email,
          name: `${firstName} ${lastName}`.trim(),
          email_verified: true,
          profile: userProfile,
        };
      },
    })
  );
}

const newprov = [
  EmailProvider({
    type: "email",
    maxAge: 10 * 60 * 60, // Magic links are valid for 10 min only
    // Here we setup the sendVerificationRequest that calls the email template with the identifier (email) and token to verify.
    sendVerificationRequest: async (props) => (await import("./sendVerificationRequest")).default(props),
  }),
];

providers.push(
  EmailProvider({
    type: "email",
    maxAge: 10 * 60 * 60, // Magic links are valid for 10 min only
    // Here we setup the sendVerificationRequest that calls the email template with the identifier (email) and token to verify.
    sendVerificationRequest: async (props) => (await import("./sendVerificationRequest")).default(props),
  })
);

function isNumber(n: string) {
  return !isNaN(parseFloat(n)) && !isNaN(+n);
}

const calcomAdapter = CalComAdapter(prisma);

const mapIdentityProvider = (providerName: string) => {
  switch (providerName) {
    case "saml-idp":
    case "saml":
      return IdentityProvider.SAML;
    default:
      return IdentityProvider.GOOGLE;
  }
};

export const AUTH_OPTIONS: AuthOptions = {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  // adapter: calcomAdapter,
  // cookies: defaultCookies(WEBAPP_URL?.startsWith("https://")),
  // pages: {
  //   signIn: "/auth/login",
  //   signOut: "/auth/logout",
  //   error: "/auth/error", // Error code passed in query string as ?error=
  //   verifyRequest: "/auth/verify",
  //   // newUser: "/auth/new", // New users will be directed here on first sign in (leave the property out if not of interest)
  // },
  providers: [],
  debug: true,
  events: {
    session: async (session) => {
      console.log("session", session);
      return;
    },
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    encode: async ({ token, secret }) => {
      console.log({ token, secret });
      const encodedToken = encode({ ...token, maxAge: Date.now(), secret });
      return encodedToken;
    },
    decode: async ({ token, secret }) => {
      console.log({ token, secret });
      const decodedToken = await decode({ token, secret });
      return decodedToken;
    },
  },
  callbacks: {
    async jwt({ token, user, account, profile }) {
      console.log({ token, user, account, profile });
      log.debug("callbacks:jwt - JWT callback called", safeStringify({ token, user, account, profile }));
      return Promise.resolve(token);
    },

    async session({ session, token, user }) {
      console.log({ session, token, user });
      log.debug("callbacks:session - Session callback called", safeStringify({ session, token, user }));
      const hasValidLicense = await checkLicense(prisma);
      const profileId = token.profileId;
      const calendsoSession: Session = {
        ...session,
        profileId,
        upId: token.upId || session.upId,
        hasValidLicense,
        user: {
          ...session.user,
          id: token.id as number,
          name: token.name,
          username: token.username as string,
          role: token.role as UserPermissionRole,
          impersonatedBy: token.impersonatedBy,
          belongsToActiveTeam: token?.belongsToActiveTeam as boolean,
          org: token?.org,
          locale: token.locale,
        },
      };
      return calendsoSession;
    },
    async signIn(params) {
      const {
        /**
         * Available when Credentials provider is used - Has the value returned by authorize callback
         */
        user,
        /**
         * Available when Credentials provider is used - Has the value submitted as the body of the HTTP POST submission
         */
        profile,
        account,
      } = params;

      log.debug("callbacks:signin", safeStringify(params));

      if (account?.provider === "email") {
        return true;
      }
      // In this case we've already verified the credentials in the authorize
      // callback so we can sign the user in.
      // Only if provider is not saml-idp
      if (account?.provider !== "saml-idp") {
        if (account?.type === "credentials") {
          return true;
        }

        if (account?.type !== "oauth") {
          return false;
        }
      }
      if (!user.email) {
        return false;
      }

      if (!user.name) {
        return false;
      }
      if (account?.provider) {
        const idP: IdentityProvider = mapIdentityProvider(account.provider);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore-error TODO validate email_verified key on profile
        user.email_verified = user.email_verified || !!user.emailVerified || profile.email_verified;

        if (!user.email_verified) {
          return "/auth/error?error=unverified-email";
        }

        let existingUser = await prisma.user.findFirst({
          include: {
            accounts: {
              where: {
                provider: account.provider,
              },
            },
          },
          where: {
            identityProvider: idP,
            identityProviderId: account.providerAccountId,
          },
        });

        /* --- START FIX LEGACY ISSUE WHERE 'identityProviderId' was accidentally set to userId --- */
        if (!existingUser) {
          existingUser = await prisma.user.findFirst({
            include: {
              accounts: {
                where: {
                  provider: account.provider,
                },
              },
            },
            where: {
              identityProvider: idP,
              identityProviderId: String(user.id),
            },
          });
          if (existingUser) {
            await prisma.user.update({
              where: {
                id: existingUser?.id,
              },
              data: {
                identityProviderId: account.providerAccountId,
              },
            });
          }
        }
        /* --- END FIXES LEGACY ISSUE WHERE 'identityProviderId' was accidentally set to userId --- */
        if (existingUser) {
          // In this case there's an existing user and their email address
          // hasn't changed since they last logged in.
          if (existingUser.email === user.email) {
            try {
              // If old user without Account entry we link their google account
              if (existingUser.accounts.length === 0) {
                const linkAccountWithUserData = { ...account, userId: existingUser.id };
                await calcomAdapter.linkAccount(linkAccountWithUserData);
              }
            } catch (error) {
              if (error instanceof Error) {
                console.error("Error while linking account of already existing user");
              }
            }
            if (existingUser.twoFactorEnabled && existingUser.identityProvider === idP) {
              return loginWithTotp(existingUser.email);
            } else {
              return true;
            }
          }

          // If the email address doesn't match, check if an account already exists
          // with the new email address. If it does, for now we return an error. If
          // not, update the email of their account and log them in.
          const userWithNewEmail = await prisma.user.findFirst({
            where: { email: user.email },
          });

          if (!userWithNewEmail) {
            await prisma.user.update({ where: { id: existingUser.id }, data: { email: user.email } });
            if (existingUser.twoFactorEnabled) {
              return loginWithTotp(existingUser.email);
            } else {
              return true;
            }
          } else {
            return "/auth/error?error=new-email-conflict";
          }
        }

        // If there's no existing user for this identity provider and id, create
        // a new account. If an account already exists with the incoming email
        // address return an error for now.

        const existingUserWithEmail = await prisma.user.findFirst({
          where: {
            email: {
              equals: user.email,
              mode: "insensitive",
            },
          },
          include: {
            password: true,
          },
        });

        if (existingUserWithEmail) {
          // if self-hosted then we can allow auto-merge of identity providers if email is verified
          if (
            !hostedCal &&
            existingUserWithEmail.emailVerified &&
            existingUserWithEmail.identityProvider !== IdentityProvider.CAL
          ) {
            if (existingUserWithEmail.twoFactorEnabled) {
              return loginWithTotp(existingUserWithEmail.email);
            } else {
              return true;
            }
          }

          // check if user was invited
          if (
            !existingUserWithEmail.password?.hash &&
            !existingUserWithEmail.emailVerified &&
            !existingUserWithEmail.username
          ) {
            await prisma.user.update({
              where: {
                email: existingUserWithEmail.email,
              },
              data: {
                // update the email to the IdP email
                email: user.email,
                // Slugify the incoming name and append a few random characters to
                // prevent conflicts for users with the same name.
                username: usernameSlug(user.name),
                emailVerified: new Date(Date.now()),
                name: user.name,
                identityProvider: idP,
                identityProviderId: account.providerAccountId,
              },
            });

            if (existingUserWithEmail.twoFactorEnabled) {
              return loginWithTotp(existingUserWithEmail.email);
            } else {
              return true;
            }
          }

          // User signs up with email/password and then tries to login with Google/SAML using the same email
          if (
            existingUserWithEmail.identityProvider === IdentityProvider.CAL &&
            (idP === IdentityProvider.GOOGLE || idP === IdentityProvider.SAML)
          ) {
            const updatedUser = await prisma.user.update({
              where: { email: existingUserWithEmail.email },
              // also update email to the IdP email
              data: {
                email: user.email,
                identityProvider: idP,
                identityProviderId: account.providerAccountId,
              },
            });

            // safely delete password from UserPassword table if it exists
            try {
              await prisma.userPassword.delete({
                where: { userId: updatedUser.id },
              });
            } catch (err) {
              if (
                err instanceof PrismaClientKnownRequestError &&
                (err.code === "P2025" || err.code === "P2016")
              ) {
                log.warn("UserPassword not found for user", safeStringify(existingUserWithEmail));
              } else {
                log.warn("Could not delete UserPassword for user", safeStringify(existingUserWithEmail));
              }
            }

            if (existingUserWithEmail.twoFactorEnabled) {
              return loginWithTotp(existingUserWithEmail.email);
            } else {
              return true;
            }
          } else if (existingUserWithEmail.identityProvider === IdentityProvider.CAL) {
            return "/auth/error?error=use-password-login";
          }

          return "/auth/error?error=use-identity-login";
        }

        // Associate with organization if enabled by flag and idP is Google (for now)
        const { orgUsername, orgId } = await checkIfUserShouldBelongToOrg(idP, user.email);

        const newUser = await prisma.user.create({
          data: {
            // Slugify the incoming name and append a few random characters to
            // prevent conflicts for users with the same name.
            username: orgId ? slugify(orgUsername) : usernameSlug(user.name),
            emailVerified: new Date(Date.now()),
            name: user.name,
            ...(user.image && { avatarUrl: user.image }),
            email: user.email,
            identityProvider: idP,
            identityProviderId: account.providerAccountId,
            ...(orgId && {
              verified: true,
              organization: { connect: { id: orgId } },
              teams: {
                create: { role: MembershipRole.MEMBER, accepted: true, team: { connect: { id: orgId } } },
              },
            }),
          },
        });

        const linkAccountNewUserData = { ...account, userId: newUser.id };
        await calcomAdapter.linkAccount(linkAccountNewUserData);

        if (account.twoFactorEnabled) {
          return loginWithTotp(newUser.email);
        } else {
          return true;
        }
      }

      return false;
    },
    /**
     * Used to handle the navigation right after successful login or logout
     */
    async redirect({ url, baseUrl }) {
      // Allows relative callback URLs
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      // Allows callback URLs on the same domain
      else if (new URL(url).hostname === new URL(WEBAPP_URL).hostname) return url;
      return baseUrl;
    },
  },
};

/**
 * Identifies the profile the user should be logged into.
 */
const determineProfile = ({
  token,
  profiles,
}: {
  token: JWT;
  profiles: { id: number | null; upId: string }[];
}) => {
  // If profile switcher is disabled, we can only show the first profile.
  if (!ENABLE_PROFILE_SWITCHER) {
    return profiles[0];
  }

  if (token.upId) {
    // Otherwise use what's in the token
    return { profileId: token.profileId, upId: token.upId as string };
  }

  // If there is just one profile it has to be the one we want to log into.
  return profiles[0];
};
