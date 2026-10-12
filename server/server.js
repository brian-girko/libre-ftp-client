const FtpServer = require("ftp-srv");
const path = require("path");
const fs = require("fs");

console.log(FtpServer);

const ROOT = path.resolve("./root");

fs.mkdirSync(ROOT, { recursive: true });

const server = new FtpServer({
  url: "ftp://0.0.0.0:2121",
  pasv_url: "127.0.0.1",
});

server.on("login", ({ username, password }, resolve, reject) => {
  if (username === "admin" && password === "password") {
    resolve({
      root: ROOT,
    });
  } else {
    reject(new Error("Invalid username or password"));
  }
});

server.listen()
  .then(() => {
    console.log("FTP server running on ftp://127.0.0.1:2121");
    console.log(`FTP root: ${ROOT}`);
  })
  .catch((err) => {
    console.error("Failed to start FTP server:", err);
  });
