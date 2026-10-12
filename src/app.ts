import express from "express";
import chatroutes from "./routes/chatroutes";

const app = express();
app.use(express.json({limit:"16kb"}));
app.get('health', (_req, res) => {
    res.status(200).json({ status:"ok"});
});
app.use("/", chatroutes);

app.use((_req, res) => {
    res.status(404).json({message: "route not found"});
});
export default app;