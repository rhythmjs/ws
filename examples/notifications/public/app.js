const user = new URLSearchParams(location.search).get("user") || "ada";
const status = document.getElementById("status");
const inbox = document.getElementById("inbox");

const socket = new WebSocket(`ws://${location.host}/ws/inbox?user=${encodeURIComponent(user)}`);

socket.addEventListener("open", () => (status.textContent = `inbox of ${user} (try ?user=grace in another tab)`));
socket.addEventListener("close", () => (status.textContent = "disconnected"));
socket.addEventListener("message", (event) => {
  const { title, body } = JSON.parse(event.data);
  const item = document.createElement("li");
  item.textContent = title;
  if (body) {
    const detail = document.createElement("span");
    detail.textContent = body;
    item.append(detail);
  }
  inbox.prepend(item);
});

document.getElementById("send").addEventListener("submit", async (event) => {
  event.preventDefault();
  const to = document.getElementById("to").value.trim();
  await fetch(`/api/notify${to ? "/" + encodeURIComponent(to) : ""}`, {
    method: "POST",
    body: JSON.stringify({
      title: document.getElementById("title").value,
      body: document.getElementById("body").value,
    }),
  });
  event.target.reset();
});
