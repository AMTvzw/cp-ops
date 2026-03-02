import { createApp } from "../server";

let appPromise: ReturnType<typeof createApp> | null = null;

const getApp = () => {
  if (!appPromise) {
    appPromise = createApp();
  }
  return appPromise;
};

export default async function handler(req: any, res: any) {
  const app = await getApp();
  return app(req, res);
}
