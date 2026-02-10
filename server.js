import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Health
app.get("/", (_, res) => res.send("HQS Backend OK"));
app.get("/ping", (_, res) => res.json({ status: "pong" }));

// Market (Frontend erwartet GENAU das)
app.get("/market", (_, res) => {
  res.json([
    { symbol: "NVDA", score: 18.86 },
    { symbol: "AMZN", score: 13.89 },
    { symbol: "MSFT", score: 10.53 },
    { symbol: "AAPL", score: 10.37 },
    { symbol: "GOOGL", score: 8.57 }
  ]);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ HQS Backend läuft stabil auf Port ${PORT}`);
});
