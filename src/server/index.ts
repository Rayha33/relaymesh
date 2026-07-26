import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, runtime, sweep } = await buildApp(config);
const sweepTimer = setInterval(sweep, config.leaseSweepMs);
sweepTimer.unref();

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down RelayMesh");
  clearInterval(sweepTimer);
  await app.close();
  runtime.close();
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await app.listen({ host: config.host, port: config.port });
  const localToken = runtime.readLocalAdminToken();
  app.log.info(
    {
      address: `http://${config.host}:${config.port}`,
      adminTokenPath:
        localToken === null ? "configured through environment" : runtime.adminTokenPath,
    },
    "RelayMesh is ready",
  );
} catch (error) {
  app.log.error(error);
  runtime.close();
  process.exitCode = 1;
}
