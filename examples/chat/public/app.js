const room = location.hash.slice(1) || "lobby";
const status = document.getElementById("status");
const log = document.getElementById("log");
const input = document.getElementById("msg");

const socket = new WebSocket(`ws://${location.host}/ws/rooms/${room}?token=demo`);

function print(line) {
  log.textContent += line + "\n";
  log.scrollTop = log.scrollHeight;
}

socket.addEventListener("open", () => {
  status.textContent = `room: ${room}`;
  input.disabled = false;
  input.focus();
});
socket.addEventListener("message", (event) => print(event.data));
socket.addEventListener("close", () => {
  status.textContent = "disconnected";
  input.disabled = true;
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && input.value) {
    socket.send(input.value);
    input.value = "";
  }
});
