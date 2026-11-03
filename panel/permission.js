document.getElementById('allow').addEventListener('click', async () => {
  const out = document.getElementById('result');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
    s.getTracks().forEach((t) => t.stop());
    out.textContent = 'Done. Close this tab and select Join call in the side panel.';
  } catch (e) {
    out.textContent = `Permission was blocked (${e.name}). Click the camera icon in the address bar to allow it, then try again.`;
  }
});
