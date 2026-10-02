const status = document.getElementById("status");
const cursors = new Map();

const socket = new WebSocket(`ws://${location.host}/ws/cursors`);

socket.addEventListener("open", () => (status.textContent = "move your mouse, open another window"));
socket.addEventListener("close", () => (status.textContent = "disconnected"));
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "move") {
    let el = cursors.get(msg.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "cursor";
      el.style.background = msg.color;
      document.body.append(el);
      cursors.set(msg.id, el);
    }
    el.style.left = msg.x * innerWidth + "px";
    el.style.top = msg.y * innerHeight + "px";
  } else if (msg.type === "leave") {
    cursors.get(msg.id)?.remove();
    cursors.delete(msg.id);
  }
});

// Send normalized coordinates, at most once per animation frame.
let pending = null;
addEventListener("mousemove", (event) => {
  const first = pending === null;
  pending = { x: event.clientX / innerWidth, y: event.clientY / innerHeight };
  if (first) {
    requestAnimationFrame(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(pending));
      pending = null;
    });
  }
});
