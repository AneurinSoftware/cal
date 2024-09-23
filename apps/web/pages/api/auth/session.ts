import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession({
    req: req,
    res: res,
  });
  res.status(200).json(session);
}
