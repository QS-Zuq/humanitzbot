/**
 * Panel Landing — multi-server landing carousel and server cards.
 *
 * @namespace Panel.landing
 */
window.Panel = window.Panel || {};

(function () {
  'use strict';

  var S = Panel.core.S;
  var $ = Panel.core.$;
  var el = Panel.core.el;
  var esc = Panel.core.esc;

  // ── Landing carousel state ────────────────────────

  var _landingSlideIdx = 0;
  var _landingSlideCount = 0;
  var _landingAutoTimer = null;
  var _landingAutoDelay = 12000; // 12s per slide

  function _landingGoTo(idx) {
    var slides = document.querySelectorAll('.landing-slide');
    var tabs = document.querySelectorAll('.landing-tab');
    if (!slides.length) return;
    idx = ((idx % slides.length) + slides.length) % slides.length;
    if (idx === _landingSlideIdx) return;
    var prev = _landingSlideIdx;

    // Old slide: add exit-left so it slides out to the left
    if (slides[prev]) {
      slides[prev].classList.remove('active');
      slides[prev].classList.add('exit-left');
    }
    if (tabs[prev]) tabs[prev].classList.remove('active');

    // Clear any other stale states
    for (var i = 0; i < slides.length; i++) {
      if (i !== prev && i !== idx) {
        slides[i].classList.remove('active', 'exit-left');
      }
      if (i !== idx && tabs[i]) tabs[i].classList.remove('active');
    }

    // New slide: force it to start from the right (no transition), then activate
    slides[idx].classList.remove('active', 'exit-left');
    slides[idx].style.transition = 'none';
    slides[idx].style.transform = 'translateX(60px)';
    slides[idx].style.opacity = '0';
    void slides[idx].offsetWidth; // reflow
    slides[idx].style.transition = '';
    slides[idx].style.transform = '';
    slides[idx].style.opacity = '';
    slides[idx].classList.add('active');
    if (tabs[idx]) tabs[idx].classList.add('active');
    _landingSlideIdx = idx;

    // Clean up exit-left after transition ends
    setTimeout(function () {
      if (slides[prev]) slides[prev].classList.remove('exit-left');
    }, 600);
  }

  function _landingStartAuto() {
    _landingStopAuto();
    if (_landingSlideCount <= 1) return;
    _landingAutoTimer = setInterval(function () {
      _landingGoTo((_landingSlideIdx + 1) % _landingSlideCount);
    }, _landingAutoDelay);
  }

  function _landingStopAuto() {
    if (_landingAutoTimer) {
      clearInterval(_landingAutoTimer);
      _landingAutoTimer = null;
    }
  }

  // ── Show Landing ──────────────────────────────────

  function showLanding() {
    $('#landing').classList.remove('hidden');
    $('#panel').classList.add('hidden');
    var skyBg = $('#skyline-bg');
    if (skyBg) skyBg.classList.remove('panel-active');
    loadLanding();

    if (typeof gsap !== 'undefined') {
      gsap.fromTo('.landing-card', { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' });
    }
  }

  // ── Load Landing ──────────────────────────────────

  async function loadLanding() {
    // Get renderServerInfo from the dashboard module
    var renderServerInfo = Panel.tabs.dashboard
      ? Panel.tabs.dashboard.renderServerInfo
      : function () {
          return '';
        };

    try {
      var r = await fetch('/api/landing');
      var d = await r.json();
      var p = d.primary;

      // Landing title — use primary server name from config
      var titleEl = $('#landing-title');
      if (titleEl && p.name) titleEl.textContent = p.name;

      // Hero header — combined status across all servers
      var anyOnline = p.status === 'online';
      if (d.servers)
        for (var ci = 0; ci < d.servers.length; ci++) {
          if (d.servers[ci].status === 'online') anyOnline = true;
        }
      var dot = $('#ls-status-dot');
      var txt = $('#ls-status-text');
      dot.className = 'landing-status-dot ' + (anyOnline ? 'online' : 'offline');
      txt.textContent = anyOnline ? i18next.t('web:dashboard.online') : i18next.t('web:map.offline');
      txt.className = 'text-xs ' + (anyOnline ? 'text-calm' : 'text-muted');

      // Build unified server list
      var allServers = [];
      allServers.push({
        name: p.name || i18next.t('web:dashboard.primary_server'),
        status: p.status,
        onlineCount: p.onlineCount,
        maxPlayers: p.maxPlayers,
        totalPlayers: p.totalPlayers,
        gameDay: p.gameDay,
        season: p.season,
        gameTime: p.gameTime,
        host: p.host,
        gamePort: p.gamePort,
        daysPerSeason: p.daysPerSeason,
        schedule: d.schedule || null,
        settings: p.settings || null,
        id: '',
      });
      if (d.servers) {
        allServers = allServers.concat(d.servers);
      }

      // Build server tabs + carousel slides
      var tabsContainer = $('#landing-server-tabs');
      var slidesContainer = $('#landing-slides');
      tabsContainer.innerHTML = '';
      slidesContainer.innerHTML = '';
      _landingSlideCount = allServers.length;

      if (allServers.length <= 1) tabsContainer.classList.add('single');
      else tabsContainer.classList.remove('single');

      for (var si = 0; si < allServers.length; si++) {
        var s = allServers[si];
        var sOn = s.status === 'online';
        var stale = s.status === 'stale';
        var statusColor = sOn ? 'online' : stale ? 'stale' : 'offline';
        var statusBg = sOn ? 'bg-calm' : stale ? 'bg-yellow-500' : 'bg-muted';
        var addr = s.host ? (s.gamePort ? s.host + ':' + s.gamePort : s.host) : '';

        // ── Tab button ──
        var tab = el('button', 'landing-tab' + (si === 0 ? ' active' : ''));
        tab.setAttribute('data-idx', '' + si);
        tab.innerHTML = '<span class="landing-tab-dot ' + statusColor + '"></span>' + esc(s.name);
        tab.addEventListener('click', function () {
          var idx = parseInt(this.getAttribute('data-idx'), 10);
          _landingGoTo(idx);
          _landingStartAuto(); // reset timer on manual click
        });
        tabsContainer.appendChild(tab);

        // ── Slide ──
        var slide = el('div', 'landing-slide' + (si === 0 ? ' active' : ''));
        var card = el('div', 'landing-server-slide');
        card.setAttribute('data-server-id', s.id || '');

        // Identity row: name + inline meta
        var identity = '<div class="slide-identity">';
        identity +=
          '<div class="slide-server-name"><span class="slide-status-dot ' +
          statusBg +
          (sOn ? ' pulse-dot' : '') +
          '"></span>' +
          esc(s.name) +
          '</div>';
        identity += '<div class="slide-meta">';

        // Players
        identity += '<div class="slide-meta-row"><i data-lucide="users" class="slide-meta-icon"></i>';
        identity +=
          '<span class="slide-meta-val">' +
          (sOn ? s.onlineCount : '-') +
          '</span> / ' +
          (s.maxPlayers || '?') +
          '</div>';
        identity += '<div class="slide-meta-row"><i data-lucide="user-check" class="slide-meta-icon"></i>';
        identity +=
          '<span class="slide-meta-val">' +
          (s.totalPlayers || 0) +
          '</span> ' +
          i18next.t('web:dashboard.total') +
          '</div>';

        // World
        if (s.gameDay != null) {
          var dps = s.daysPerSeason || 28,
            seasonNames = [
              i18next.t('web:dashboard.spring'),
              i18next.t('web:dashboard.summer'),
              i18next.t('web:dashboard.autumn'),
              i18next.t('web:dashboard.winter'),
            ];
          var seasonNum = Math.floor((s.gameDay % (dps * 4)) / dps);
          var dayInSeason = (s.gameDay % dps) + 1;
          var year = Math.floor(s.gameDay / (dps * 4)) + 1;
          var worldStr = '';
          if (s.gameTime) worldStr += s.gameTime + ' · ';
          worldStr +=
            i18next.t('web:dashboard.day_of_season', { day: dayInSeason, season: s.season || seasonNames[seasonNum] }) +
            ', ' +
            i18next.t('web:dashboard.year_short', { year: year });
          identity += '<div class="slide-meta-row"><i data-lucide="globe" class="slide-meta-icon"></i>';
          identity += '<span class="slide-meta-val">' + worldStr + '</span></div>';
        }

        // Address
        if (addr) {
          identity += '<div class="slide-meta-row"><i data-lucide="link" class="slide-meta-icon"></i>';
          identity += '<span class="slide-addr">' + esc(addr) + '</span></div>';
        }

        identity += '</div>'; // /slide-meta
        identity += '</div>'; // /slide-identity

        // Divider
        var divider = '<div class="slide-divider"></div>';

        // Schedule (if active)
        var schedHtml = '';
        var sched = s.schedule;
        if (sched && sched.active) {
          schedHtml += '<div class="slide-schedule">';
          schedHtml += '<div class="slide-section-title">' + i18next.t('web:dashboard.schedule_title');
          if (sched.timezone)
            schedHtml +=
              ' <span class="text-[9px] text-muted/50 font-mono normal-case tracking-normal">' +
              esc(sched.timezone) +
              '</span>';
          schedHtml += '</div>';
          schedHtml += '<div class="slide-schedule-list" data-server-idx="' + si + '"></div>';
          if (sched.nextRestart) {
            var mins = sched.minutesUntilRestart;
            var hrs = Math.floor(mins / 60);
            var m = mins % 60;
            var untilStr = hrs > 0 ? hrs + 'h ' + m + 'm' : m + 'm';
            schedHtml +=
              '<div class="text-[10px] text-muted mt-1">' +
              i18next.t('web:dashboard.next_transition', { time: untilStr, at: sched.nextRestart }) +
              '</div>';
          }
          if (sched.rotateDaily)
            schedHtml +=
              '<div class="text-[9px] text-muted/40 mt-0.5">' +
              i18next.t('web:dashboard.schedule_rotates_daily') +
              '</div>';
          schedHtml += '</div>';
        }

        // Server info (rules, threats, loot, world stats)
        var infoHtml = '';
        if (s.settings) {
          infoHtml += '<div class="slide-info"><div class="srv-info-panel">';
          infoHtml += renderServerInfo(s.settings, s);
          infoHtml += '</div></div>';
        }

        // Active modules (feature pills)
        var modsHtml = '';
        var mods = s.modules || [];
        if (mods.length) {
          var modLabels = {
            rcon: { icon: 'terminal', label: 'RCON', tip: i18next.t('web:dashboard.mod_rcon_tip') },
            db: {
              icon: 'database',
              label: i18next.t('web:dashboard.mod_database'),
              tip: i18next.t('web:dashboard.mod_db_tip'),
            },
            sftp: { icon: 'hard-drive', label: 'SFTP', tip: i18next.t('web:dashboard.mod_sftp_tip') },
            schedule: {
              icon: 'calendar-clock',
              label: i18next.t('web:dashboard.mod_schedule'),
              tip: i18next.t('web:dashboard.mod_schedule_tip'),
            },
            logs: {
              icon: 'scroll-text',
              label: i18next.t('web:dashboard.mod_logs'),
              tip: i18next.t('web:dashboard.mod_logs_tip'),
            },
            chat: {
              icon: 'message-square',
              label: i18next.t('web:dashboard.mod_chat'),
              tip: i18next.t('web:dashboard.mod_chat_tip'),
            },
            anticheat: {
              icon: 'shield-check',
              label: i18next.t('web:dashboard.mod_anticheat'),
              tip: i18next.t('web:dashboard.mod_anticheat_tip'),
            },
            hzmod: {
              icon: 'cpu',
              label: i18next.t('web:dashboard.mod_plugin'),
              tip: i18next.t('web:dashboard.mod_plugin_tip'),
            },
          };
          modsHtml += '<div class="slide-modules">';
          for (var mi = 0; mi < mods.length; mi++) {
            var modItem = modLabels[mods[mi]] || { icon: 'circle', label: mods[mi], tip: '' };
            modsHtml += '<span class="slide-mod-pill" data-tippy-content="' + esc(modItem.tip) + '">';
            modsHtml += '<i data-lucide="' + modItem.icon + '"></i>' + modItem.label + '</span>';
          }
          modsHtml += '</div>';
        }

        // Assemble card: identity → divider → modules → schedule → info
        var cardContent = identity;
        if (modsHtml || schedHtml || infoHtml) cardContent += divider;
        if (modsHtml) cardContent += modsHtml;
        if (schedHtml) cardContent += schedHtml;
        if (infoHtml) cardContent += infoHtml;
        card.innerHTML = cardContent;

        slide.appendChild(card);
        slidesContainer.appendChild(slide);

        // Render schedule slots (needs DOM)
        if (sched && sched.active) {
          var schedList = card.querySelector('.slide-schedule-list');
          if (schedList && Panel.tabs.settings) {
            Panel.tabs.settings.renderSchedule(schedList, sched, 'landing');
            if (sched.rotateDaily && sched.tomorrowSchedule) {
              Panel.tabs.settings.renderTomorrowSchedule(schedList, sched);
            }
          }
        }

        // Plugin content (hzmod) embedded in matching slide
        if (s.id && window.__panelPlugins?.hzmod?.renderLandingCard && d.hzmod) {
          var hzServerId = d.hzmodServerId || 'vps_dev';
          if (s.id === hzServerId) {
            var pluginDiv = el('div', 'mt-2 pt-2 border-t border-border/50');
            pluginDiv.innerHTML = window.__panelPlugins.hzmod.renderLandingCard(d.hzmod);
            card.appendChild(pluginDiv);
          }
        }

        // Activate Lucide + Tippy inside card
        if (window.lucide) lucide.createIcons({ nodes: [card] });
        if (window.tippy) {
          card.querySelectorAll('[data-tippy-content]').forEach(function (n) {
            tippy(n, { theme: 'translucent', placement: 'top', delay: [200, 0], duration: [150, 100] });
          });
        }

        // Store primary schedule for dashboard
        if (si === 0 && sched && sched.active) S.scheduleData = sched;
      }

      // Tab tooltips
      if (window.tippy) {
        tabsContainer.querySelectorAll('.landing-tab').forEach(function (_n) {
          // No tooltip needed — the name is already visible in the tab
        });
      }

      // Pause auto-rotate on hover over the slide area
      var carouselEl = $('#landing-carousel');
      if (carouselEl) {
        carouselEl.addEventListener('mouseenter', function () {
          _landingStopAuto();
          carouselEl.classList.add('paused');
        });
        carouselEl.addEventListener('mouseleave', function () {
          carouselEl.classList.remove('paused');
          _landingStartAuto();
        });
      }
      // Also pause on tab hover
      tabsContainer.addEventListener('mouseenter', function () {
        _landingStopAuto();
        if (carouselEl) carouselEl.classList.add('paused');
      });
      tabsContainer.addEventListener('mouseleave', function () {
        if (carouselEl) carouselEl.classList.remove('paused');
        _landingStartAuto();
      });

      // Set CSS custom property for progress bar duration to match JS timer
      if (carouselEl) carouselEl.style.setProperty('--landing-delay', _landingAutoDelay / 1000 + 's');

      // Start auto-rotation
      _landingStartAuto();

      var discordLink = $('#link-discord');
      if (discordLink) {
        var inviteUrl = p.discordInvite || '';
        if (inviteUrl) {
          var fullUrl = inviteUrl.startsWith('http') ? inviteUrl : 'https://' + inviteUrl;
          discordLink.href = fullUrl;
          $('#landing-links').classList.remove('hidden');
          var authBtn = $('#landing-auth-btn');
          if (authBtn && S.user.authenticated && S.tier < 1) authBtn.href = fullUrl;
        } else {
          $('#landing-links').classList.remove('hidden');
          discordLink.style.display = 'none';
          var sep = discordLink.parentElement.querySelector('.text-border');
          if (sep) sep.remove();
        }
      }
    } catch (e) {
      console.error('Landing fetch error:', e);
      $('#ls-status-text').textContent = i18next.t('web:dashboard.error');
    }
  }

  Panel.landing = {
    show: showLanding,
    load: loadLanding,
    stopAuto: _landingStopAuto,
  };
})();
