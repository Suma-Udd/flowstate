/* ==========================================================================
   First-run setup

   Six short steps, all skippable, all reachable again from Settings:

     welcome → speech model → microphone → shortcut → cleanup → try it

   The model download starts by itself on step two, because it is the one slow
   thing and everything after it can happen while it runs. The window around
   it hides the sidebar (see onboarding.css) so this reads as a guided flow,
   not a settings page.

   Nothing here is a new capability. It is the existing bridge (model, mics,
   micPreview, hotkey, config, llm) in a friendlier order.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {}).onboarding = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STEPS = [
    { key: 'welcome', label: 'Welcome' },
    { key: 'model', label: 'Speech model' },
    { key: 'mic', label: 'Microphone' },
    { key: 'hotkey', label: 'Shortcut' },
    { key: 'cleanup', label: 'Cleanup' },
    { key: 'try', label: 'Try it' }
  ];

  var KEY_LABEL = { Meta: 'Win' };
  var BAR_COUNT = 24;
  var HEARD_LEVEL = 0.18;

  function chordHtml(esc, chord) {
    return chord.map(function (key) {
      return '<kbd class="kbd">' + esc(KEY_LABEL[key] || key) + '</kbd>';
    }).join('<span class="chord-plus" aria-hidden="true">+</span>');
  }

  function dotsHtml(esc, index) {
    return '<ol class="onb-steps" aria-label="Setup progress">'
      + STEPS.map(function (step, i) {
          return '<li class="onb-step' + (i === index ? ' is-current' : '') + (i < index ? ' is-done' : '')
            + '"' + (i === index ? ' aria-current="step"' : '') + '>'
            + '<span class="onb-step-dot" aria-hidden="true"></span>'
            + '<span class="onb-step-label">' + esc(step.label) + '</span></li>';
        }).join('')
      + '</ol>';
  }

  /* --- one function per step, each returning { html, mount(root, api) } --- */

  function welcomeStep(ctx) {
    var icon = ctx.lib.icon;
    return {
      html: function () {
        return ''
          + '<div class="onb-hero">'
          + '<span class="onb-mark" aria-hidden="true"></span>'
          + '<h1 class="onb-title">Welcome to Flowstate</h1>'
          + '<p class="onb-lead">Hold a key, say what you want to write, let go. Clean text appears'
          + ' wherever your cursor is, in any app.</p>'
          + '</div>'
          + '<ul class="onb-points">'
          + '<li>' + icon('mic') + '<span><strong>Your voice stays on this PC.</strong> Speech is'
          + ' recognised locally. Nothing is recorded or uploaded.</span></li>'
          + '<li>' + icon('sparkle') + '<span><strong>Optional cleanup.</strong> Add a key for any'
          + ' OpenAI-compatible service and Flowstate fixes punctuation and filler words.</span></li>'
          + '<li>' + icon('clock') + '<span><strong>Two minutes.</strong> One download, a microphone'
          + ' check, and you are dictating.</span></li>'
          + '</ul>';
      },
      next: 'Get started'
    };
  }

  function modelStep(ctx) {
    var esc = ctx.lib.esc;
    return {
      html: function () {
        return ''
          + '<h1 class="onb-title">Get the speech model</h1>'
          + '<p class="onb-lead">Flowstate needs a speech recognition model. It is about 490 MB,'
          + ' downloaded once from the open-source sherpa-onnx project and kept on this PC.</p>'
          + '<div class="onb-model">'
          + '<progress class="progress" data-progress max="100" value="0">0%</progress>'
          + '<div class="onb-model-line"><span data-model-title>Checking…</span>'
          + '<span class="mono" data-model-percent>0%</span></div>'
          + '<p class="onb-hint" data-model-detail></p>'
          + '<div data-model-error aria-live="polite"></div>'
          + '<div class="btn-row">'
          + '<button type="button" class="btn" data-action="model-retry" hidden>Try again</button>'
          + '<button type="button" class="btn is-quiet" data-action="model-pause" hidden>Pause</button>'
          + '</div>'
          + '</div>'
          + '<p class="onb-hint">You can carry on with the next steps while this runs. Dictation'
          + ' switches on by itself when the download finishes.</p>';
      },
      mount: function (root, api) {
        var bridge = ctx.bridge;
        var bar = root.querySelector('[data-progress]');
        var title = root.querySelector('[data-model-title]');
        var percentEl = root.querySelector('[data-model-percent]');
        var detail = root.querySelector('[data-model-detail]');
        var errorEl = root.querySelector('[data-model-error]');
        var retry = root.querySelector('[data-action="model-retry"]');
        var pause = root.querySelector('[data-action="model-pause"]');

        var COPY = {
          checking: ['Checking local files…', ''],
          missing: ['Starting the download…', ''],
          corrupt: ['Fetching a fresh copy…', 'The local copy did not pass its check.'],
          downloading: ['Downloading…', 'Pausing keeps what is already downloaded.'],
          verifying: ['Verifying…', 'Checking the file is exactly what was published.'],
          installing: ['Unpacking…', 'Almost there.'],
          cancelled: ['Paused', 'Resume whenever you like.'],
          error: ['The download did not finish', ''],
          ready: ['Ready', 'The speech model is installed.']
        };

        function paintModel(status) {
          var phase = COPY[status && status.phase] ? status.phase : 'error';
          var copy = COPY[phase];
          var value = Math.max(0, Math.min(100, Number(status && status.percent) || 0));
          bar.value = phase === 'ready' ? 100 : value;
          title.textContent = copy[0];
          percentEl.textContent = (phase === 'ready' ? 100 : Math.round(value)) + '%';
          detail.textContent = copy[1];
          errorEl.innerHTML = status && status.error
            ? '<div class="notice is-danger">' + ctx.lib.icon('alert') + '<p>' + esc(status.error) + '</p></div>'
            : '';
          retry.hidden = !(phase === 'error' || phase === 'cancelled');
          retry.textContent = phase === 'cancelled' ? 'Resume' : 'Try again';
          pause.hidden = phase !== 'downloading';
          api.setState({ modelReady: phase === 'ready' });
        }

        function start() {
          retry.disabled = true;
          Promise.resolve(bridge.model.download()).then(function (status) {
            if (status) paintModel(status);
          }, function (error) {
            paintModel({ phase: 'error', error: ctx.lib.ipcErrorMessage(error) });
          }).then(function () { retry.disabled = false; });
        }

        retry.addEventListener('click', start);
        pause.addEventListener('click', function () { bridge.model.cancelDownload(); });

        var off = bridge.model.onProgress(paintModel);
        bridge.model.status().then(function (status) {
          paintModel(status);
          if (status.phase !== 'ready' && status.phase !== 'downloading'
              && status.phase !== 'verifying' && status.phase !== 'installing') {
            start();
          }
        }, function (error) {
          paintModel({ phase: 'error', error: ctx.lib.ipcErrorMessage(error) });
        });

        return function () { if (typeof off === 'function') off(); };
      },
      next: 'Continue'
    };
  }

  function micStep(ctx) {
    var esc = ctx.lib.esc;
    return {
      html: function () {
        var bars = '';
        for (var i = 0; i < BAR_COUNT; i++) bars += '<span class="meter-bar"></span>';
        return ''
          + '<h1 class="onb-title">Check your microphone</h1>'
          + '<p class="onb-lead">Say something in your normal voice. The bars should move.</p>'
          + '<div class="field">'
          + '<label class="field-label" for="onb-mic">Microphone</label>'
          + '<select class="select" id="onb-mic" data-mic-select><option>Looking for microphones…</option></select>'
          + '</div>'
          + '<div class="onb-meter">'
          + '<div class="meter" data-meter role="img" aria-label="Input level meter">' + bars + '</div>'
          + '<div class="meter-scale"><span>Silent</span><span>Speaking</span></div>'
          + '</div>'
          + '<div class="onb-heard" data-heard aria-live="polite"></div>'
          + '<div data-mic-error aria-live="polite"></div>';
      },
      mount: function (root) {
        var bridge = ctx.bridge;
        var select = root.querySelector('[data-mic-select]');
        var bars = root.querySelectorAll('.meter-bar');
        var heard = root.querySelector('[data-heard]');
        var errorEl = root.querySelector('[data-mic-error]');
        var levels = new Array(BAR_COUNT).fill(0);
        var sawVoice = false;
        var current = null;
        var unsubscribers = [];

        function paint() {
          for (var i = 0; i < bars.length; i++) bars[i].style.setProperty('--level', String(levels[i]));
        }
        paint();

        function begin(deviceId) {
          errorEl.innerHTML = '';
          levels.fill(0);
          paint();
          bridge.micPreview.start(deviceId).catch(function () { /* onError reports it */ });
        }

        unsubscribers.push(bridge.micPreview.onLevel(function (level) {
          levels.shift();
          levels.push(level);
          paint();
          if (!sawVoice && level >= HEARD_LEVEL) {
            sawVoice = true;
            heard.innerHTML = '<div class="notice">' + ctx.lib.icon('check')
              + '<p>Got it. Flowstate can hear you.</p></div>';
          }
        }));
        unsubscribers.push(bridge.micPreview.onError(function (message) {
          errorEl.innerHTML = '<div class="notice is-danger">' + ctx.lib.icon('alert')
            + '<p>' + esc(message) + ' If Windows asked for microphone access, allow it and try again.</p></div>';
        }));

        function paintMics(mics) {
          select.innerHTML = mics.length === 0
            ? '<option value="" disabled selected>No microphone found</option>'
            : mics.map(function (mic) {
                return '<option value="' + esc(mic.deviceId) + '"' + (mic.deviceId === current ? ' selected' : '')
                  + '>' + esc(mic.label) + (mic.isDefault ? ' — system default' : '') + '</option>';
              }).join('');
        }

        select.addEventListener('change', function () {
          current = select.value;
          bridge.config.set({ audio: { deviceId: current } }).catch(function () {});
          begin(current);
        });

        bridge.config.get().then(function (config) {
          current = config.audio.deviceId;
          return bridge.mics.list();
        }).then(function (mics) {
          paintMics(mics);
          if (mics.length > 0) {
            var selected = mics.filter(function (m) { return m.deviceId === current; })[0] || mics[0];
            current = selected.deviceId;
            select.value = current;
            begin(current);
          }
        }).catch(function (error) {
          errorEl.innerHTML = '<div class="notice is-danger">' + ctx.lib.icon('alert')
            + '<p>' + esc(ctx.lib.ipcErrorMessage(error)) + '</p></div>';
        });

        unsubscribers.push(bridge.mics.onDeviceChange(paintMics));

        return function () {
          for (var i = 0; i < unsubscribers.length; i++) {
            if (typeof unsubscribers[i] === 'function') unsubscribers[i]();
          }
          bridge.micPreview.stop().catch(function () {});
        };
      },
      next: 'Continue'
    };
  }

  function hotkeyStep(ctx) {
    var esc = ctx.lib.esc;
    return {
      html: function () {
        return ''
          + '<h1 class="onb-title">Hold to talk</h1>'
          + '<p class="onb-lead">Hold these keys, speak, then let go. Your words are pasted where your'
          + ' cursor is.</p>'
          + '<div class="chord onb-chord" data-chord></div>'
          + '<p class="onb-hint" data-hotkey-hint aria-live="polite">A quick tap does nothing, so'
          + ' brushing the keys never pastes by accident.</p>'
          + '<div class="btn-row"><button type="button" class="btn" data-action="change-shortcut">'
          + ctx.lib.icon('pencil') + '<span data-label>Change shortcut</span></button></div>';
      },
      mount: function (root) {
        var bridge = ctx.bridge;
        var chordEl = root.querySelector('[data-chord]');
        var hint = root.querySelector('[data-hotkey-hint]');
        var button = root.querySelector('[data-action="change-shortcut"]');
        var label = root.querySelector('[data-label]');
        var normal = hint.textContent;
        var rebinding = false;

        function paintChord(chord) { chordEl.innerHTML = chordHtml(esc, chord); }
        function setRebinding(active) {
          rebinding = active;
          label.textContent = active ? 'Cancel' : 'Change shortcut';
          hint.textContent = active ? 'Press your new shortcut, or Escape to cancel.' : normal;
          hint.classList.remove('is-danger');
        }

        bridge.hotkey.get().then(function (value) { paintChord(value.chord); }, function () {
          paintChord(['Ctrl', 'Meta']);
        });

        var off = bridge.hotkey.onRebindResult(function (result) {
          setRebinding(false);
          if (result.status === 'accepted') paintChord(result.chord);
          else if (result.status === 'rejected') {
            hint.textContent = result.reason || 'That shortcut could not be used.';
            hint.classList.add('is-danger');
          }
        });

        button.addEventListener('click', function () {
          if (rebinding) {
            bridge.hotkey.cancelRebind().catch(function () {});
            setRebinding(false);
            return;
          }
          bridge.hotkey.startRebind().then(function () { setRebinding(true); }, function (error) {
            hint.textContent = ctx.lib.ipcErrorMessage(error);
            hint.classList.add('is-danger');
          });
        });

        return function () {
          if (typeof off === 'function') off();
          if (rebinding) bridge.hotkey.cancelRebind().catch(function () {});
        };
      },
      next: 'Continue'
    };
  }

  function cleanupStep(ctx) {
    return {
      html: function () {
        var provider = ctx.views && ctx.views['cleanup-provider'];
        return ''
          + '<h1 class="onb-title">Polish your text <span class="onb-optional">optional</span></h1>'
          + '<p class="onb-lead">Without a key, Flowstate pastes exactly what it heard. With one, a small'
          + ' language model adds punctuation, fixes casing and drops filler words. Only the text is sent,'
          + ' never audio.</p>'
          + '<div data-provider-slot>' + (provider ? provider.shell() : '') + '</div>';
      },
      mount: function (root) {
        var provider = ctx.views && ctx.views['cleanup-provider'];
        var slot = root.querySelector('[data-provider-slot]');
        return provider ? provider.mount(slot, ctx) : function () {};
      },
      next: 'Continue',
      skip: 'Skip, use raw text'
    };
  }

  function tryStep(ctx) {
    return {
      html: function () {
        return ''
          + '<h1 class="onb-title">Try it</h1>'
          + '<p class="onb-lead">Click in the box, hold <span data-try-chord></span>, say a sentence and let go.</p>'
          + '<label class="visually-hidden" for="onb-try">Practice box</label>'
          + '<textarea class="textarea onb-try" id="onb-try" rows="5" data-try'
          + ' placeholder="Your words will appear here…"></textarea>'
          + '<div data-try-status aria-live="polite"></div>'
          + '<div class="rows onb-rows"><div class="row">'
          + '<div class="row-main"><p class="row-label">Start Flowstate when I sign in</p>'
          + '<p class="row-hint">It waits quietly in the tray. You can change this in Settings.</p></div>'
          + '<div class="row-action">'
          + '<label class="visually-hidden" for="onb-autostart">Start Flowstate when I sign in</label>'
          + ctx.lib.toggle('onb-autostart', 'Start Flowstate when I sign in', true)
          + '</div></div></div>';
      },
      mount: function (root) {
        var bridge = ctx.bridge;
        var area = root.querySelector('[data-try]');
        var status = root.querySelector('[data-try-status]');
        var chordSlot = root.querySelector('[data-try-chord]');
        var auto = root.querySelector('#onb-autostart');

        bridge.hotkey.get().then(function (value) {
          chordSlot.innerHTML = chordHtml(ctx.lib.esc, value.chord);
        }, function () {});

        bridge.config.get().then(function (config) {
          auto.checked = config.system.autostart !== false;
        }).catch(function () {});
        auto.addEventListener('change', function () {
          bridge.config.set({ system: { autostart: auto.checked } }).catch(function () {
            auto.checked = !auto.checked;
          });
        });

        var offResult = bridge.dictation.onResult(function () {
          status.innerHTML = '<div class="notice">' + ctx.lib.icon('check')
            + '<p>That is it. This works in every app: chat, email, documents, code.</p></div>';
        });

        // Dictation pastes with Ctrl+V into whatever has focus, so the box
        // just needs focus. Nothing special is wired to it.
        setTimeout(function () { area.focus(); }, 50);

        function paintWaiting(modelStatus) {
          if (modelStatus && modelStatus.phase === 'ready') {
            if (status.getAttribute('data-waiting') === 'true') {
              status.removeAttribute('data-waiting');
              status.innerHTML = '';
            }
            return;
          }
          status.setAttribute('data-waiting', 'true');
          status.innerHTML = '<div class="notice is-warn">' + ctx.lib.icon('alert')
            + '<p>The speech model is still downloading' + (modelStatus && modelStatus.percent
              ? ' (' + Math.round(modelStatus.percent) + '%)' : '')
            + '. Dictation starts the moment it finishes.</p></div>';
        }
        var offModel = bridge.model.onProgress(paintWaiting);
        bridge.model.status().then(paintWaiting, function () {});

        return function () {
          if (typeof offResult === 'function') offResult();
          if (typeof offModel === 'function') offModel();
        };
      },
      next: 'Finish'
    };
  }

  function buildSteps(ctx) {
    return [welcomeStep(ctx), modelStep(ctx), micStep(ctx), hotkeyStep(ctx), cleanupStep(ctx), tryStep(ctx)];
  }

  return {
    STEPS: STEPS,
    html: function (ctx) {
      var esc = ctx.lib.esc;
      return ''
        + '<div class="onb" data-onboarding>'
        + '<div class="onb-top">'
        + '<span class="onb-brand"><span class="brand-mark" aria-hidden="true"></span>Flowstate setup</span>'
        + '<button type="button" class="btn is-quiet" data-action="skip-all">Skip setup</button>'
        + '</div>'
        + '<div data-onb-dots>' + dotsHtml(esc, 0) + '</div>'
        + '<section class="onb-card" data-onb-card></section>'
        + '<div class="onb-foot">'
        + '<button type="button" class="btn is-quiet" data-action="back">Back</button>'
        + '<span class="onb-foot-gap"></span>'
        + '<button type="button" class="btn is-quiet" data-action="skip-step" hidden></button>'
        + '<button type="button" class="btn is-primary on-accent is-large" data-action="next">Get started</button>'
        + '</div>'
        + '</div>';
    },

    mount: function (root, ctx) {
      var bridge = ctx.bridge;
      var steps = buildSteps(ctx);
      var index = 0;
      var teardownStep = null;
      var disposed = false;
      var state = { modelReady: false };

      var card = root.querySelector('[data-onb-card]');
      var dots = root.querySelector('[data-onb-dots]');
      var back = root.querySelector('[data-action="back"]');
      var next = root.querySelector('[data-action="next"]');
      var skipStep = root.querySelector('[data-action="skip-step"]');

      if (!bridge) {
        card.innerHTML = '<p class="onb-lead">Setup needs the desktop app.</p>';
        return function () {};
      }

      var api = {
        setState: function (patch) {
          for (var key in patch) state[key] = patch[key];
        }
      };

      function leaveStep() {
        if (typeof teardownStep === 'function') {
          try { teardownStep(); } catch (error) { /* a step's cleanup must not trap the user */ }
        }
        teardownStep = null;
      }

      function show(i) {
        leaveStep();
        index = Math.max(0, Math.min(steps.length - 1, i));
        var step = steps[index];
        dots.innerHTML = dotsHtml(ctx.lib.esc, index);
        card.innerHTML = step.html();
        back.hidden = index === 0;
        next.textContent = step.next;
        skipStep.hidden = !step.skip;
        if (step.skip) skipStep.textContent = step.skip;
        if (typeof step.mount === 'function') teardownStep = step.mount(card, api) || null;
        var heading = card.querySelector('h1');
        if (heading && typeof heading.focus === 'function') { heading.setAttribute('tabindex', '-1'); heading.focus(); }
      }

      function finish() {
        bridge.config.set({ onboarding: { completed: true } }).catch(function () {}).then(function () {
          if (!disposed) ctx.navigate('/dictation');
        });
      }

      root.addEventListener('click', function (event) {
        var button = event.target.closest('[data-action]');
        if (!button || disposed) return;
        var action = button.getAttribute('data-action');
        if (action === 'next') {
          if (index === steps.length - 1) finish();
          else show(index + 1);
        } else if (action === 'back') {
          show(index - 1);
        } else if (action === 'skip-step') {
          show(index + 1);
        } else if (action === 'skip-all') {
          finish();
        }
      });

      show(0);

      return function teardown() {
        disposed = true;
        leaveStep();
      };
    }
  };
});
