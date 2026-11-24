// A deployment/network interruption must not strand a live Telegram QR login.
export function createQrPoller({ fetchState, onState, onError, now = Date.now, schedule = setTimeout, unschedule = clearTimeout }) {
  let generation = 0, timer;
  function stop() { generation++; unschedule(timer); }
  function start(id) {
    stop();
    const run = generation, started = now();
    let failures = 0;
    async function poll() {
      try {
        const state = await fetchState(id);
        if (run !== generation) return;
        if (state.status === "pending_qr" && now() - started >= 60000)
          throw Object.assign(new Error("telegram_qr_preparation_timeout"), { retryable: false });
        failures = 0;
        await onState(state, id);
        if (run === generation && ["pending_qr", "qr_ready", "password_required"].includes(state.status))
          timer = schedule(poll, 2000);
      } catch (error) {
        if (run !== generation) return;
        const retrying = error.retryable !== false && ++failures < 6;
        onError(error, { retrying, id });
        if (retrying) timer = schedule(poll, Math.min(1000 * 2 ** failures, 8000));
      }
    }
    return poll();
  }
  return { start, stop };
}
