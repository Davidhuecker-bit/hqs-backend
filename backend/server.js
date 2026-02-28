// backend/server.js

require("dotenv").config();
const express = require("express");
const stockRoute = require("./routes/stock");

const app = express();
app.use(express.json());

app.use("/api/stock", stockRoute);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
