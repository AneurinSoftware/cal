import { LRUCache } from "lru-cache";
import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from "next";
import type { AuthOptions, Session } from "next-auth";

import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { UserRepository } from "@calcom/lib/server/repository/user";
import prisma from "@calcom/prisma";

const log = logger.getSubLogger({ prefix: ["getServerSession"] });
/**
 * Stores the session in memory using the stringified token as the key.
 *
 */
const CACHE = new LRUCache<string, Session>({ max: 1000 });

/**
 * This is a slimmed down version of the `getServerSession` function from
 * `next-auth`.
 *
 * Instead of requiring the entire options object for NextAuth, we create
 * a compatible session using information from the incoming token.
 *
 * The downside to this is that we won't refresh sessions if the users
 * token has expired (30 days). This should be fine as we call `/auth/session`
 * frequently enough on the client-side to keep the session alive.
 */
// export async function getServerSession(options: {
//   req: NextApiRequest | GetServerSidePropsContext["req"];
//   res?: NextApiResponse | GetServerSidePropsContext["res"];
//   authOptions?: AuthOptions;
// }) {
//   log.debug("Getting server session");
//   const { req, authOptions: { secret } = {} } = options;
//
//   const token = await getToken({
//     req,
//     secret,
//   });
//
//   if (!token || !token.email || !token.sub) {
//     log.debug("Couldnt get token");
//     return null;
//   }
//
//   const cachedSession = CACHE.get(JSON.stringify(token));
//
//   if (cachedSession) {
//     return cachedSession;
//   }
//
//   const userFromDb = await prisma.user.findUnique({
//     where: {
//       email: token.email.toLowerCase(),
//     },
//     // TODO: Re-enable once we get confirmation from compliance that this is okay.
//     // cacheStrategy: { ttl: 60, swr: 1 },
//   });
//
//   if (!userFromDb) {
//     log.debug("No user found");
//     return null;
//   }
//
//   const hasValidLicense = await checkLicense(prisma);
//
//   let upId = token.upId;
//
//   if (!upId) {
//     upId = `usr-${userFromDb.id}`;
//   }
//
//   if (!upId) {
//     log.error("No upId found for session", { userId: userFromDb.id });
//     return null;
//   }
//
//   const user = await UserRepository.enrichUserWithTheProfile({
//     user: userFromDb,
//     upId,
//   });
//
//   const session: Session = {
//     hasValidLicense,
//     expires: new Date(typeof token.exp === "number" ? token.exp * 1000 : Date.now()).toISOString(),
//     user: {
//       id: user.id,
//       name: user.name,
//       username: user.username,
//       email: user.email,
//       emailVerified: user.emailVerified,
//       email_verified: user.emailVerified !== null,
//       role: user.role,
//       image: getUserAvatarUrl({
//         ...user,
//         profile: user.profile,
//       }),
//       belongsToActiveTeam: token.belongsToActiveTeam,
//       org: token.org,
//       locale: user.locale ?? undefined,
//       profile: user.profile,
//     },
//     profileId: token.profileId,
//     upId,
//   };
//
//   if (token?.impersonatedBy?.id) {
//     const impersonatedByUser = await prisma.user.findUnique({
//       where: {
//         id: token.impersonatedBy.id,
//       },
//       select: {
//         id: true,
//         role: true,
//       },
//     });
//     if (impersonatedByUser) {
//       session.user.impersonatedBy = {
//         id: impersonatedByUser?.id,
//         role: impersonatedByUser.role,
//       };
//     }
//   }
//
//   CACHE.set(JSON.stringify(token), session);
//
//   console.log({ sessionCal: session, profile: session.user.profile });
//   log.debug("Returned session", safeStringify(session));
//   return session;
// }

export async function getServerSession(options: {
  req: NextApiRequest | GetServerSidePropsContext["req"];
  res?: NextApiResponse | GetServerSidePropsContext["res"];
  authOptions?: AuthOptions;
}) {
  console.log("Getting server session");
  log.debug("Getting server session");
  const { req, authOptions: { secret } = {} } = options;

  const getSession = await fetch("http://localhost:3006/api/auth/session", {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Cookie: req.headers.cookie,
    },
  });
  const sesh = await getSession.json();
  if (!sesh) {
    log.debug("Couldnt get token");
    return null;
  }

  const cachedSession = CACHE.get(JSON.stringify(sesh));

  if (cachedSession) {
    return cachedSession;
  }

  const userFromDb = await prisma.user.findUnique({
    where: {
      id: sesh.user.calUser.id,
    },
    // TODO: Re-enable once we get confirmation from compliance that this is okay.
    // cacheStrategy: { ttl: 60, swr: 1 },
  });

  if (!userFromDb) {
    log.debug("No user found");
    return null;
  }

  console.log({ sesh });

  const upId = `usr-${sesh.user.calUser.id}`;

  const user = await UserRepository.enrichUserWithTheProfile({
    user: userFromDb,
    upId,
  });

  const session: Session = {
    hasValidLicense: false,
    expires: sesh.session.expires,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      email_verified: user.emailVerified !== null,
      role: user.role,
      image: getUserAvatarUrl({
        ...user,
        profile: user.profile,
      }),
      belongsToActiveTeam: true,
      org: undefined,
      locale: user.locale ?? undefined,
      profile: user.profile,
    },
    profileId: null,
    upId,
  };

  // const session: Session = {
  //   hasValidLicense: true,
  //   expires: sesh.session.expires,
  //   user: {
  //     id: sesh.user.calUser.id,
  //     name: sesh.user.calUser.name,
  //     username: sesh.user.calUser.username,
  //     email: sesh.user.email,
  //     emailVerified: sesh.user.emailVerified,
  //     email_verified: sesh.user.emailVerified !== null,
  //     role: sesh.user.calUser.role,
  //     image: sesh.user.calUser.image,
  //     belongsToActiveTeam: false,
  //     org: undefined,
  //     locale: sesh.user.calUser.locale ?? "en",
  //     profile: user.profile,
  //   },
  //   profileId: null,
  //   upId,
  // };

  log.debug("Returned session", safeStringify(session));
  return session;
}
