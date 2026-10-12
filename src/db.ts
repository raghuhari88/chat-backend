import { Pool } from "pg";
import "dotenv/config";

export const pool = new Pool({
   connectionSring: process.env.DATABASE_URL,
   max:20,
   idleTimeoutmillis: 30_000,
   connectionTimeoutmillis:5_00,

});

pool.on("error", (error:Error) => {
    console.error("Unexpected PostgreSql Pool error", error);
});
