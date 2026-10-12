import "dotenv/config";
import app from "./app";
import {pool} from "./db";
const port = Number(process.env.PORT ?? 4000);
async function startServer(): Promise<void>{
    await pool.query("SELECT 1");
    cost server = app.listen(port, () => {
        console.log(`Chat API running on port ${port}`);
    });

    const shutdown =  async (): Promise<void> => {
        server.close(async () => {
            await pool.end();
            process.exit(0);
        });
    };
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());

    startServer().catch((error: unknown) => {
        console.error("failed to start server", error);
        process.exit(1);
    });
}