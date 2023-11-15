//Installation
// git clone https://github.com/ggerganov/llama.cpp.git
// cd llama.cpp
// sed -i 's/-arch=native/-arch=all/g' Makefile
// make clean && LLAMA_CUBLAS=1 make  -j
//Copyright Denis Spasyuk
//License MIT

const express = require("express");
const { spawn } = require("child_process");
const http = require("http");
const socketIO = require("socket.io");
var cors = require("cors");
const path = require("path");
const vdb = require("./db.js");
const fs = require("fs");

const version = 0.19;
var session = require("express-session");
const config = require("./config.js");
if (config.login) {
  var hash = require("./hash.js");
}
function ser() {}

ser.init = function (error) {
  console.log(
    config.llamacpp + " " + Object.entries(config.params).flat().join(" ")
  );
  this.connectedClients = new Map();
  this.socketId = null;
  ser.checkModel();
  this.messageQueue = []; // Queue to store messages from clients
  this.isProcessing = false; // Flag to track if a message is being processed
  this.runLLamaChild();
  this.buffer = "";
  if (config.piper.enabled) {
    this.fullmessage = "";
    this.piperChild();
    this.aplayChild();
    this.FileStream();
    this.piper.stdout.pipe(this.aplay.stdin);
  }
  // Listen for the 'exit' event to handle process exit.

  this.app = express();
  this.server = http.createServer(this.app);
  this.sessionStore= session(config.session)
  this.app.use(this.sessionStore);
  this.app.use(cors());
  this.io = socketIO(this.server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });
  this.io.engine.use(this.sessionStore);
  this.io.on("connection", (socket) => this.handleSocketConnection(socket));
  this.app.use(express.json());
  this.app.use(express.urlencoded({ extended: true }));
  this.app.set("views", path.join(__dirname, "views"));
  this.app.set("view engine", "ejs");
  this.app.use(express.static(path.join(__dirname, "public")));
  // Define a route to render the EJS view
  this.app.get("/", ser.loggedIn, (req, res, next) => {
    res.render("index", {
      title: "Llama.cui",
      version: version,
      hostname: config.IP.client,
      port: config.PORT.client,
      datachannel: JSON.stringify(
        Object.keys(Object.fromEntries(config.dataChannel))
      ),
    });
  });

  this.app.post("/stopper",  async (request, response) => {
    console.log("STOPPING");
    ser.llamachild.kill("SIGINT");
    this.messageQueue.splice(0, 1);
    this.isProcessing = false;
    this.processMessageQueue();
    response.send({ message: "stopped" });
  });

  this.app.get("/login",  (req, res) => {
    if (!config.login) {
      return res.redirect("/");
    } else {
      res.render("login", { title: "login" });
    }
  });

  this.app.get("/logout", async (req, res) => {
    req.session.destroy();
    res.render("logout", { user: config.username });
  });

  this.app.post("/login",   async (req, res) => {
    if (!config.login) {
      return res.redirect("/");
    } else {
      const username = req.body.username;
      const password = req.body.password;
      try {
        if (!username || !password) {
          res.render("login", { title: "login" });
        } else {
          // Query your database to get user credentials
          //const results = await db.find("users", { "username": username });
          let users = await config.loginTrue(username); //replace this with database query
          if (users.length === 0) {
            res.render("login", { title: "login" });
          } else {
            // Compare the provided password with the stored password

            if (await hash.comparePassword(password, users.password)) {
              // Authentication successful
              req.session.loggedin = true;
              req.session.username = username;
              res.redirect("/");
            } else {
              res.render("login", { title: "login" });
            }
          }
        }
      } catch (error) {
        // Handle errors gracefully
        console.error("Error during login:", error);
        res.status(500).send("Internal Server Error");
      }
    }
  });

  this.start();
};

ser.isFileExistsSync = function (filePath) {
  try {
    console.log(fs.statSync(filePath).isFile());
    return fs.statSync(filePath).isFile();
  } catch (err) {
    console.log(err);
    return false;
  }
};

ser.checkModel = function () {
  if (ser.isFileExistsSync(config.params["--model"])) {
    console.log("Model exists");
  } else {
    console.log("Model does not exist");
    console.log("Please download model", config.params["--model"]);
    // config.getModel();
  }
};

ser.runLLamaChild = function () {
  var configParams = Object.entries(config.params).flat();
  this.llamachild = spawn(
    config.llamacpp,
    configParams.filter((item) => item !== ""),
    {
      stdio: ["pipe", "pipe", process.stderr],
    }
  );

  this.llamachild.stdout.on("data", (msg) => this.handleLlama(msg));

  this.llamachild.on("exit", (code, signal) => {
    if (code !== null) {
      console.log(`Child process exited with code ${code}`);
      this.runLLamaChild();
    } else if (signal !== null) {
      console.log(`Child process terminated by signal ${signal}`);
      this.runLLamaChild();
    }
  });
};

ser.loggedIn = function (req, res, next) {
  if (!config.login) {
    req.session.loggedin = true;
  }
  if (req.session.loggedin) {
    next();
  } else {
    res.redirect("/login");
  }
};

ser.handleLlamaError = function (error) {
  console.error("An error occurred in the llama child process:", error);
  // Handle the error appropriately, e.g., logging, cleanup, etc.
};

ser.aplayChild = function () {
  this.aplay = spawn("aplay", [
    "-r",
    config.piper.rate,
    "-f",
    config.piper.output_file,
    "-t",
    "raw",
    "-",
  ]);
};

ser.piperChild = function () {
  this.piper = spawn(config.piper.exec, [
    "--model",
    config.piper.model,
    "--output-raw",
  ]);
};

ser.FileStream = function () {
  this.wavFileStream = fs.createWriteStream("output.wav");
};

ser.runPiper = function (output) {
  if (config.piper.enabled) {
    this.fullmessage += " " + output;
    if (
      this.fullmessage.includes(".") ||
      this.fullmessage.includes(":") ||
      this.fullmessage.includes(";") ||
      this.fullmessage.includes("!") ||
      this.fullmessage.includes("?")
    ) {
      this.piper.stdin.write(this.fullmessage + "\n");
      console.log("fullmesd", this.fullmessage);
      this.fullmessage = "";
    }
  }
};

ser.handleLlama = function (msg) {
  this.buffer += msg.toString("utf-8");
  let lastSpaceIndex = this.buffer.lastIndexOf(" ");
  if (lastSpaceIndex !== -1) {
    let output = this.buffer.substring(0, lastSpaceIndex);
    this.buffer = this.buffer.substring(lastSpaceIndex + 1);
    // output = parseOutput(output);
    if (output) {
      clearTimeout(this.streamTimeout);
    }
    // console.log(output);
    this.io.to(this.socketId).emit("output", output);
    this.runPiper(output);
    if (output.includes("\n>")) {
      this.messageQueue.splice(0, 1);
      this.isProcessing = false;
      this.processMessageQueue();
    }
  }
};

ser.processMessageQueue = function () {
  if (this.messageQueue.length === 0) {
    this.isProcessing = false;
    return;
  }
  this.isProcessing = true;
  const message = this.messageQueue[0];
  const { socketId, input } = message;
  this.socketId = socketId;
  // Send the message to the child process
  if (config.promptAddUserID) {
    this.llamachild.stdin.write(`${input}` + "\n");
  } else {
    this.llamachild.stdin.write(`${input}` + "\n");
  }
};

ser.handleTimeout = function () {
  console.log("Timeout");
  ser.isProcessing = false;
  ser.llamachild.kill("SIGINT");
};

ser.handleSocketConnection = async function (socket) {
  if (socket.request.session.loggedin){
    socket.on("message",  async (data) => {
      
      var input = data.message;
      var embed = "";
      if (data.embedding) {
        console.log("embedding");
        embed = await vdb.init(input);
      }
      var socketId = data.socketid;
      input = config.prompt(socketId, input, embed);
      input = input + "\\";
      console.log(input);
      this.connectedClients.set(socketId, input);
      // Add the incoming message to the queue
      this.messageQueue.push({ socketId, input });
      this.streamTimeout = setTimeout(this.handleTimeout, config.timeout);
      // Process messages if the queue is not being processed currently
      if (!this.isProcessing) {
        this.processMessageQueue();
      }
    });
    socket.on("error", function () {
      console.log("Error", error);
    });
    socket.on("disconnect", () => {
      this.connectedClients.delete(socket.id);
    });
  }    else{
     console.log("Not Logged In!");
     socket.emit("redirect-login");
     // Disconnect the socket
     socket.disconnect(true);
  }  
};

ser.start = function () {
  this.server.listen(config.PORT.server, config.IP.server, () => {
    console.log(
      "Server Running on:",
      config.IP.server + ":" + config.PORT.server
    );
  });
};

ser.init();
