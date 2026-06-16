setInterval(() => {
  console.log(`[worker] heartbeat ${new Date().toISOString()}`);
}, 5000);
