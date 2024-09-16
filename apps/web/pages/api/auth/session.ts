import { getServerSession } from "@calcom/features/auth/lib/getServerSession";

export default async function handler(req, res) {
  const session = await getServerSession({
    req: req,
    res: res,
  });
  res.status(200).json(session);
}
