(function () {
  const origin = location.origin;
  const shareUrl = origin + '/';
  const shareText = 'GH Fares — ask any route in Ghana, get the approved fare.';

  const hint = document.getElementById('copyHint');
  if (hint) hint.textContent = shareUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

  const shareBtn = document.getElementById('sharePage');
  if (shareBtn) {
    shareBtn.addEventListener('click', async function (e) {
      e.preventDefault();
      if (navigator.share) {
        try {
          await navigator.share({ title: 'GH Fares', text: shareText, url: shareUrl });
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      window.location.href = '/go';
    });
  }

  const copyBtn = document.getElementById('copyLink');
  if (copyBtn) {
    copyBtn.addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(shareUrl);
        if (hint) hint.textContent = 'Copied';
      } catch (err) {
        prompt('Copy this link', shareUrl);
      }
    });
  }
})();
