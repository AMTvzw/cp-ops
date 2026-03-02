import { createApp } from "../server.js";

let appPromise: ReturnType<typeof createApp> | null = null;

const getApp = () => {
  if (!appPromise) {
    appPromise = createApp().catch((error) => {
      // Allow next invocation to retry initialization after transient failures.
      appPromise = null;
      throw error;
    });
  }
  return appPromise;
};

export default async function handler(req: any, res: any) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (error) {
    console.error("Serverless app initialization failed:", error);
    return res.status(500).json({ error: "Server initialization failed" });
  }
}
