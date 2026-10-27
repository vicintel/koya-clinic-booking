// Local server: DATABASE_URL=postgres:///koya_booking API_KEY=dev-key node dev.js
const app = require("./lib/booking-app");

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
