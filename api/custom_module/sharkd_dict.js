const {PromiseSocket} = require('promise-socket');
const { spawn } = require('child_process');
const JSONStream = require('JSONStream');
const fs = require('fs');

const SHARKD_SOCKET = process.env.SHARKD_SOCKET || "/var/run/sharkd.sock";

// Make sure CAPTURES_PATH has a trailing /
let _captures_path = process.env.CAPTURES_PATH || "/captures/";
if (_captures_path.at(-1) !== "/") {
  _captures_path += "/";
}
const CAPTURES_PATH = _captures_path;
delete _captures_path

// --- DCL Variables ---
// Flag to indicate if a spawn attempt is currently in progress
let isSpawningSharkd = false;
// Promise to wait on if a spawn is already in progress
let sharkdSpawnPromise = null;
// --- ---


// newer versions of sharkd are picky about JSON types
// from sharkd_session.c: struct member_attribute name_array[]
const SHARKD_INTEGER_PARAMS = new Set(["frame", "ref_frame", "prev_frame", "skip", "limit", "interval"]);
const SHARKD_BOOLEAN_PARAMS = new Set(["proto", "columns", "color", "bytes", "hidden"]);
const SHARKD_TRUE_VALUES = new Set(["yes", "true", "1"]);

var sharkd_objects = {};
var AsyncLock = require('async-lock');
var lock = new AsyncLock({timeout: 300000}); // 5 minutes timeout for the lock
var sharkd_proc = null;
const sleep = (waitTimeInMs) => new Promise(resolve => setTimeout(resolve, waitTimeInMs));

/**
 * Returns array of socket names with loaded pcap file
 * @returns {[string]} Array of existing sharkd sockets with loaded file
 */
get_loaded_sockets = function() {
  let return_array = [];
  Object.keys(sharkd_objects).forEach(function(socket_name){
    if (sharkd_objects[socket_name].stream.readable) {
      return_array.push(socket_name);
    } else {
      sharkd_objects[socket_name].destroy();
      delete sharkd_objects[socket_name];
    }
  });
  return return_array;
}

/**
 * Returns a sharkd socket with the PCAP file loaded
 * @param {string} capture the full path of the pcap file to load
 * @returns {PromiseSocket} sharkd socket with loaded file
 */
get_sharkd_cli = async function(capture) {
  // Normalize the socket name from the capture file path
  let socket_name = capture.replace(CAPTURES_PATH,"");
  if (socket_name.startsWith("/")) {
    socket_name = socket_name.substr(1);
  }

  // --- First Check: Socket already exists ---
  // Check if we already have a socket object for this capture
  if (socket_name in sharkd_objects) {
    // Check if the existing socket is still usable
    if (sharkd_objects[socket_name].stream.readable === false || sharkd_objects[socket_name].stream.destroyed === true) {
      console.log(`Socket for ${socket_name} found but not readable/destroyed. Cleaning up.`);
      // Ensure proper cleanup before deleting
      try {
        sharkd_objects[socket_name].destroy();
      } catch (e) {
        console.warn(`Error destroying old socket for ${socket_name}: ${e.message}`);
      }
      delete sharkd_objects[socket_name];
      // Retry getting the socket after cleanup
      return get_sharkd_cli(capture);
    }
    // Return the existing, valid socket
    console.log(`Returning existing socket for ${socket_name}`);
    return sharkd_objects[socket_name];
  }

  // --- No existing socket object, attempt to create/connect ---
  let new_socket = new PromiseSocket();
  new_socket.setTimeout(300000); // 5 minutes timeout per socket connection
  new_socket.stream.setEncoding('utf8');

  try {
    // Attempt to connect to the sharkd Unix socket
    console.log(`Attempting to connect to sharkd at ${SHARKD_SOCKET} for capture ${socket_name}`);
    await new_socket.connect(SHARKD_SOCKET);
    console.log(`Successfully connected to ${SHARKD_SOCKET} for ${socket_name}`);

    // Store the newly connected socket
    sharkd_objects[socket_name] = new_socket;

    // If a capture file is specified, send the 'load' command
    if(capture !== '') {
      console.log(`Sending load command for capture: ${capture}`);
      await send_req({'method':'load', 'file': capture}, sharkd_objects[socket_name]);
      console.log(`Load command sent successfully for ${capture}`);
    }

    // Return the new socket
    return sharkd_objects[socket_name];

  } catch(err) {
    // --- Connection Failed: sharkd might not be running ---
    console.log(`Connection to ${SHARKD_SOCKET} failed for ${socket_name}. Error: ${err.message}`);
    // Connection failed, likely means sharkd process is not running or socket is stale.
    // We need to potentially spawn it.

    // --- Double-Checked Locking: Check if another call is already spawning ---
    // First check (part of DCL): Is a spawn already in progress?
    if (isSpawningSharkd) {
      console.log("Spawn already in progress, waiting...");
      try {
        // Wait for the ongoing spawn attempt to complete
        await sharkdSpawnPromise;
        console.log("Ongoing spawn finished, retrying get_sharkd_cli...");
        // Retry the entire function after the other spawn attempt finished
        return get_sharkd_cli(capture);
      } catch (spawnWaitError) {
          console.error(`Error waiting for concurrent sharkd spawn: ${spawnWaitError.message}`);
          // Propagate the error from the failed spawn attempt
          throw spawnWaitError;
      }
    }

    // --- Acquire Lock and Perform Second Check ---
    // Set the flag indicating that *this* call will attempt to spawn sharkd
    isSpawningSharkd = true;
    // Create the promise that other concurrent calls can wait on
    // We wrap the spawn logic in a self-executing async function to create the promise
    sharkdSpawnPromise = (async () => {
        console.log("Acquired spawn lock. Proceeding to potentially spawn sharkd.");

        // --- Double-Check (inside lock): Re-verify if sharkd started in the meantime ---
        // Although less likely with the flag, we could theoretically try a quick reconnect here
        // as a strict double-check. However, the primary goal is preventing multiple spawns,
        // which the flag handles. We'll proceed directly to spawning logic.

        // Kill any potentially defunct sharkd process tracked by us
        if (sharkd_proc !== null && sharkd_proc.pid) {
            console.log(`Killing existing tracked sharkd process (PID: ${sharkd_proc.pid})`);
            try {
                // Use SIGTERM first for graceful shutdown, then SIGKILL if needed
                if (!sharkd_proc.kill('SIGTERM')) {
                   await sleep(100); // Give it a moment to terminate
                   if (!sharkd_proc.killed) {
                       console.warn(`sharkd (PID: ${sharkd_proc.pid}) did not terminate gracefully, sending SIGKILL.`);
                       sharkd_proc.kill('SIGKILL');
                   }
                }
            } catch (killError) {
                console.warn(`Error trying to kill previous sharkd process: ${killError.message}`);
                // Ignore error and proceed, process might already be gone
            }
            await sleep(250); // Wait a bit after killing
            sharkd_proc = null;
        }

        // --- Spawn the new sharkd process ---
        try {
            console.log(`Trying to spawn sharkd unix:${SHARKD_SOCKET}`);
            // Ensure the socket file does not exist before spawning
            // Note: This requires 'fs/promises' or similar file system access
            try {
                const fs = require('fs/promises');
                await fs.unlink(SHARKD_SOCKET);
                console.log(`Removed existing socket file ${SHARKD_SOCKET} if it existed.`);
            } catch (unlinkError) {
                // Ignore error if file doesn't exist (ENOENT)
                if (unlinkError.code !== 'ENOENT') {
                    console.warn(`Could not remove existing socket file ${SHARKD_SOCKET}: ${unlinkError.message}`);
                }
            }

            // Spawn sharkd
            sharkd_proc = spawn('sharkd', ['unix:' + SHARKD_SOCKET], { stdio: ['ignore', 'pipe', 'pipe'] }); // ignore stdin, pipe stdout/stderr

            // Handle potential immediate spawn errors
            sharkd_proc.on('error', (spawnError) => {
                console.error(`Failed to start sharkd process: ${spawnError.message}`);
                sharkd_proc = null; // Clear the process variable
                // Reject the promise, signaling spawn failure
                throw new Error(`Error spawning sharkd: ${spawnError.message}`); // Throw inside async function to cause promise rejection
            });

            // Log stderr
            sharkd_proc.stderr.on('data', (data) => {
                console.error(`sharkd stderr: ${data.toString().trim()}`);
            });

            // Log stdout
            sharkd_proc.stdout.on('data', (data) => {
                console.log(`sharkd stdout: ${data.toString().trim()}`);
            });

            // Handle process exit
            sharkd_proc.on('exit', (code, signal) => {
              console.warn(`sharkd process (PID: ${sharkd_proc ? sharkd_proc.pid : 'unknown'}) exited with code ${code}, signal ${signal}`);
              // If the process exits later unexpectedly, other parts of the application might need to handle it,
              // potentially by attempting to reconnect or restart, which would involve checking sharkd_proc's state then.
            });

            console.log(`Spawned sharkd process with PID: ${sharkd_proc.pid}`);
            await sleep(500); // Give sharkd a moment to initialize or fail

            // --- Critical Check AFTER sleep ---
            // Check if the process object still exists AND if it has an exit code already
            if (sharkd_proc && sharkd_proc.exitCode !== 0) {
                // If exitCode is not null here, it means the process terminated during/before the sleep.
                // This IS a failure for a daemon, regardless of the code (0 or otherwise).
                throw new Error(`Error spawning sharkd under ${SHARKD_SOCKET}. sharkd exited too quickly with code ${sharkd_proc.exitCode}. Check logs.`);
            }
            // Check if the process object somehow became null (e.g., 'error' event)
            if (!sharkd_proc) {
                throw new Error(`Error spawning sharkd under ${SHARKD_SOCKET}. Process object became null shortly after spawn. Check 'error' event logs.`);
            }

            // If we reach here, the process hasn't exited yet. Assume it's running.
            console.log("sharkd spawn seems successful (process running after sleep).");
        } catch (err_spawn) {
            console.error(`Error during sharkd spawn attempt: ${err_spawn.message}`);
            console.error('!!! Spawn Error Details:', spawnError); // Log the full error object
            sharkd_proc = null; // Ensure proc is cleared on error
            // Re-throw the error to reject the sharkdSpawnPromise
            throw err_spawn;
        }
    })(); // Immediately invoke the async function to start the spawn process

    // --- Wait for the spawn attempt and release lock ---
    try {
      // Wait for the spawn promise (created above) to resolve or reject
      await sharkdSpawnPromise;
      console.log("Spawn attempt finished (or seemed successful after wait). Releasing lock and retrying connection.");
    } catch (spawnError) {
      console.error(`Caught error from sharkd spawn attempt: ${spawnError.message}`);
      // Release the lock even if spawn failed
      isSpawningSharkd = false;
      sharkdSpawnPromise = null;
      // Propagate the error: the spawn failed, so we cannot proceed.
      // Or decide if process.exit is appropriate based on your app's needs.
      // process.exit(1); // Original code had exits, uncomment if needed, but throwing is often better.
      throw new Error(`Failed to spawn sharkd: ${spawnError.message}`);
    } finally {
      // --- Release Lock ---
      // Always release the lock flag and clear the promise after the attempt
      isSpawningSharkd = false;
      sharkdSpawnPromise = null;
      console.log("Spawn lock released.");
    }

    // --- Retry Connection ---
    // After successfully waiting for (or performing) the spawn, retry the entire function.
    // This ensures we try to connect again now that sharkd *should* be running.
    console.log("Retrying get_sharkd_cli after spawn attempt...");
    return get_sharkd_cli(capture);
  }
}

/**
 * Checks if str is a valid JSON object
 * @param {string} str the string to check
 * @returns {boolean} is str a valid JSON object
 */
function _str_is_json(str) {
  try {
    var json = JSON.parse(str);
    return (typeof json === 'object');
  } catch (e) {
    return false;
  }
}

/**
 * Sends a command to the socket and return the answer as string.
 * If no sock is provided, one is requested from `get_sharkd_cli` using the capture file inside the request
 * @param {string} request the string to check
 * @param {PromiseSocket|null} sock optional socket to use for communication
 * @returns {string} data returned from sharkd as string
 */
let jsonrpc_id=0;
send_req = async function(request, sock) {
  let cap_file = '';

  // newer versions of sharkd require jsonrpc, add required fields to request
  // FIXME: should use a jsonrpc library for this
  request["jsonrpc"] = "2.0";
  request["id"] = ++jsonrpc_id;

  // FIXME: should update the frontend/backend to use a POST with json
  // the current approach of GET params makes every value a string
  for (var key of Object.keys(request)) {
    if (SHARKD_INTEGER_PARAMS.has(key)) {
      if(typeof request[key] === "string" || request[key] instanceof String) {
        request[key] = parseInt(request[key]);
      }
    }
    if (SHARKD_BOOLEAN_PARAMS.has(key)) {
      if(typeof request[key] === "string" || request[key] instanceof String) {
        request[key] = SHARKD_TRUE_VALUES.has(request[key]);
      }
    }
  }

  if ("capture" in request) {
    if (request.capture.includes('..')) {
      return JSON.stringify({"err": 1, "errstr": "Nope"});
    }

    let req_capture = request.capture;

    // newer versions of sharkd don't allow extraneous fields
    // capture is used by webshark to track connection handles
    delete request.capture;

    if (req_capture.startsWith("/")) {
      req_capture = req_capture.substr(1);
    }

    cap_file = `${CAPTURES_PATH}${req_capture}`;

    // verify that pcap exists
    if (fs.existsSync(cap_file) === false) {
      return JSON.stringify({"err": 1, "errstr": "Nope"});
    }
  }

  async function _send_req_internal() {
    let new_sock = sock;
    if (typeof(new_sock) === 'undefined') {
      new_sock = await get_sharkd_cli(cap_file);
    }

    if (new_sock === null) {
      return JSON.stringify({"err": 1, "errstr": `cannot connect to sharkd using socket: ${SHARKD_SOCKET}`});
    }
    try {
      await new_sock.write(JSON.stringify(request)+"\n");
    } catch (err) {
      console.log("Error writing to sharkd socket")
      console.log(err)
      return null;
    }

    let result = await readAndParseSocket(new_sock);

    if ("result" in result) {
      result = result["result"];
    }

    return JSON.stringify(result);
  }

  return await lock.acquire(cap_file, _send_req_internal);
}

/**
 * Reads data from the socket stream and parses it into a JSON object.
 * The parser will end when the stream ends, and the parsed data will be returned.
 *
 * @param {Object} socket - The socket object containing the data stream, must have a `stream` property.
 * @returns {Promise<Object>} A Promise that resolves to the parsed JSON data.
 */
async function readAndParseSocket(socket) {
  return new Promise((resolve, reject) => {
    const stream = socket.stream;
    const parser = JSONStream.parse();

    let data = '';

    stream.on('data', (chunk) => {
      data += chunk;
      parser.write(chunk);
    });

    parser.on('data', (parsedData) => {
      resolve(parsedData);
    });

    parser.on('error', (err) => {
      reject(err);
    });

    stream.on('end', () => {
      parser.end();
    });
  });
}

exports.get_sharkd_cli = get_sharkd_cli;
exports.send_req = send_req;
exports.get_loaded_sockets = get_loaded_sockets;
