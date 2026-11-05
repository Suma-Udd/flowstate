'use strict';

function createTrayBitmap(size = 32) {
  const bitmap = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size * 0.44;

  function setPixel(x, y, red, green, blue, alpha = 255) {
    if (x < 0 || x >= size || y < 0 || y >= size) {
      return;
    }
    const offset = (y * size + x) * 4;
    bitmap[offset] = blue;
    bitmap[offset + 1] = green;
    bitmap[offset + 2] = red;
    bitmap[offset + 3] = alpha;
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (Math.hypot(x - centre, y - centre) <= radius) {
        setPixel(x, y, 28, 90, 84);
      }
    }
  }

  for (let x = 7; x <= 24; x += 1) {
    const waveY = Math.round(centre + Math.sin(((x - 7) / 17) * Math.PI * 4) * 3);
    setPixel(x, waveY - 1, 255, 255, 255);
    setPixel(x, waveY, 255, 255, 255);
    setPixel(x, waveY + 1, 255, 255, 255);
  }

  return bitmap;
}

function createTrayIcon(nativeImage) {
  const size = 32;
  const icon = nativeImage
    .createFromBitmap(createTrayBitmap(size), { width: size, height: size, scaleFactor: 1 })
    .resize({ width: 16, height: 16 });
  if (icon.isEmpty()) {
    throw new Error('Flowstate tray icon could not be created.');
  }
  return icon;
}

function createAppTray({
  Menu,
  Tray,
  nativeImage,
  onOpen,
  onSettings,
  onQuit,
  onDictationChange,
  dictationEnabled = true,
}) {
  let enabled = Boolean(dictationEnabled);
  const tray = new Tray(createTrayIcon(nativeImage));
  tray.setToolTip('Flowstate');

  function rebuildMenu() {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open Flowstate',
          click: onOpen,
        },
        { type: 'separator' },
        {
          label: 'Dictation on/off',
          type: 'checkbox',
          checked: enabled,
          click(menuItem) {
            enabled = menuItem.checked;
            onDictationChange(enabled);
            rebuildMenu();
          },
        },
        {
          label: 'Settings',
          click: onSettings,
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: onQuit,
        },
      ])
    );
  }

  rebuildMenu();
  tray.on('click', onOpen);

  return {
    tray,
    isDictationEnabled: () => enabled,
    setDictationEnabled(value) {
      const next = Boolean(value);
      if (next !== enabled) {
        enabled = next;
        rebuildMenu();
      }
    },
    destroy() {
      tray.destroy();
    },
  };
}

module.exports = {
  createAppTray,
  createTrayBitmap,
  createTrayIcon,
};
