process.on("message", (message) => {
  if (message?.type !== "jagentdesk_frame") return;
  process.send?.(message);
});
