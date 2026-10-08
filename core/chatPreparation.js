// Start independent work eagerly, but keep errors observable by its eventual
// consumer even if request persistence fails before that consumer is reached.
function startChatTask(work) {
  const task = Promise.resolve().then(work);
  void task.catch(() => {});
  return task;
}

module.exports = { startChatTask };
