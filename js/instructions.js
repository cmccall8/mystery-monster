// Instructions work before joining a room, including when Firebase is unavailable.
const instructions = document.getElementById("instructions");
document.getElementById("howToPlay").addEventListener("click", () => instructions.showModal());
document.getElementById("instructionsClose").addEventListener("click", () => instructions.close());
instructions.addEventListener("click", event => {
  if (event.target !== instructions) return;
  const rect = instructions.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) instructions.close();
});
