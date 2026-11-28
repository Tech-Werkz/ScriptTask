/**
* @description MeshCentral ScriptTask
* @author Ryan Blenis
* @author Desmond Duval (modifications)
* Modified by Desmond Duval, 2026: redesigned interface, scheduling engine, batches, permissions and settings. See changelog.md.
* Permissions: every permission defaults to denied, and is checked through MeshCentral's getAccessPermissions (see the Permissions section).
* @copyright
* @license Apache-2.0
*/

"use strict";

// MeshCentral loads plugins with require(), and removing, reinstalling or upgrading a plugin doesn't clear Node's
// module cache. Until MeshCentral restarts, require() can return the previous version of this file. So the factory
// compares this code's version with the one on disk; when they differ, it drops the plugin's files from the cache
// and builds the plugin from the new files instead.
var path = require('path');
function versionOnDisk() {
    try { return JSON.parse(require('fs').readFileSync(path.join(__dirname, 'config.json'), 'utf8')).version; } catch (e) { return null; }
}
var LOADED_VERSION = versionOnDisk();
var INSTANCE_KEY = Symbol.for('meshcentral.plugin.scripttask.instance');

module.exports.scripttask = function (parent) {
    var onDisk = versionOnDisk();
    if (onDisk != null && LOADED_VERSION != null && onDisk != LOADED_VERSION) {
        console.log('PLUGIN: ScriptTask: loading version ' + onDisk + ' in place of ' + LOADED_VERSION + '. Restart MeshCentral when convenient.');
        Object.keys(require.cache).forEach(function (k) { if (k.startsWith(__dirname + path.sep)) delete require.cache[k]; });
        return require(path.join(__dirname, 'scripttask.js')).scripttask(parent);
    }
    // An earlier instance in this process (the plugin was reloaded, reinstalled or upgraded without a restart) stops
    // checking the queue, so two copies never send the same runs
    if (global[INSTANCE_KEY] && typeof global[INSTANCE_KEY].shutdown == 'function') global[INSTANCE_KEY].shutdown();

    var obj = {};
    global[INSTANCE_KEY] = obj;
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.db = null;
    obj.intervalTimer = null;
    obj.debug = obj.meshServer.debug;
    obj.VIEWS = __dirname + '/views/';
    obj.INCLUDES = __dirname + '/includes/';
    obj.version = LOADED_VERSION;
    obj.stopped = false;
    obj.exports = [
        'onDeviceRefreshEnd',
        'getBus',
        'onRpcResult',
        'onInvalidate',
        'hideTab'
    ];

    const MESHRIGHT_REMOTECOMMAND = 0x00020000;
    const SITERIGHT_FULLADMIN = 0xFFFFFFFF;
    const RECUR_TYPES = ['once', 'minutes', 'hourly', 'daily', 'weekly'];
    const FILE_TYPES = ['ps1', 'bat', 'bash'];

    // Plugin permissions, managed in MeshCentral's plugin permissions dialog (MeshCentral 1.1.58+).
    // Every permission defaults to 'denied': nobody can use the plugin until an administrator grants a permission.
    obj.permissions = {
        manage: {
            title: 'Manage ScriptTask',
            desc: 'Edit the script library and variables, and run or schedule scripts on many devices at once.',
            default: 'denied'
        },
        run: {
            title: 'Run scripts',
            desc: 'Run and schedule library scripts on a device from its ScriptTask tab, and view that device\'s queue and history. Also requires the device\'s Remote Commands right.',
            default: 'denied'
        }
    };

    // The queue check runs on an interval from Settings (every minute by default)
    obj.timerSeconds = null;
    obj.resetQueueTimer = function() {
        clearInterval(obj.intervalTimer);
        if (obj.stopped) return;
        obj.timerSeconds = obj.settingsCache ? obj.settingsCache.queueIntervalSeconds : obj.SETTINGS_DEFAULTS.queueIntervalSeconds;
        obj.intervalTimer = setInterval(obj.queueRun, obj.timerSeconds * 1000);
    };

    obj.shutdown = function() {
        obj.stopped = true;
        clearInterval(obj.intervalTimer);
    };
    // Disabling or removing the plugin drops it from MeshCentral's list without telling it; stop when that happens
    obj.isActive = function() {
        if (obj.stopped) return false;
        if (parent.plugins != null && parent.plugins.scripttask !== obj) { obj.shutdown(); return false; }
        return true;
    };

    obj.server_startup = function() {
        // Registered here, not at load: MeshCentral loads plugins before its permission functions exist
        if (!obj.registerPermissions()) console.log('PLUGIN: ScriptTask: no plugin permission API (registerPermissions); limited to full administrators');
        else console.log('PLUGIN: ScriptTask: plugin permissions registered; ' + obj.describePermissionApi());
        obj.meshServer.pluginHandler.scripttask_db = require (__dirname + '/db.js').CreateDB(obj.meshServer);
        obj.db = obj.meshServer.pluginHandler.scripttask_db;
        obj.resetQueueTimer();
    };

    // ---- Client-side exports (serialized into the MeshCentral web UI's pluginHandler) ----

    // MeshCentral clears the device's plugin tabs and calls this each time the device page refreshes (nodeid is the device's id).
    // ScriptTask's tab is added only for a user the server says may use ScriptTask on this device, so everyone else gets no tab,
    // and no Plugins tab at all if ScriptTask was the only plugin. The answer is remembered here: 5 minutes for yes, 1 minute for no.
    // (The server decides again when the tab's page is requested, so a remembered yes can't open anything the user may not use.)
    obj.onDeviceRefreshEnd = function(nodeid, panel, refresh, event) {
        if (typeof nodeid != 'string') return;
        var known = (window.scripttaskTabAccess = window.scripttaskTabAccess || {})[nodeid];
        var addTab = function() {
            pluginHandler.registerPluginTab({ tabTitle: 'ScriptTask', tabId: 'pluginScriptTask' });
            if (Q('pluginIframeScriptTask') == null) QA('pluginScriptTask', '<iframe id="pluginIframeScriptTask" style="width: 100%; height: calc(100vh - 260px); min-height: 480px; border: 0; display: block; overflow: auto;" scrolling="auto" frameBorder=0 src="/pluginadmin.ashx?pin=scripttask&user=1&nodeid=' + encodeURIComponent(nodeid) + '" />');
        };
        window.scripttaskTabReq = null; // Any answer still on its way is for an earlier refresh
        if (known != null && known.until > Date.now()) { if (known.show) addTab(); return; } // MeshCentral selects the user's last plugin tab right after this
        var bus = pluginHandler.scripttask.getBus(), timer = null;
        var reqId = 'sttab' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        window.scripttaskTabReq = reqId;
        var onReply = function(type, msg) {
            if (type != 'rpc' || msg.reqId != reqId) return;
            bus.off(onReply); clearTimeout(timer);
            var show = msg.ok === true && msg.data != null && msg.data.show === true;
            if (msg.ok === true) window.scripttaskTabAccess[nodeid] = { show: show, until: Date.now() + (show ? 300000 : 60000) };
            if (!show || window.scripttaskTabReq != reqId) return;
            if (typeof currentNode == 'object' && currentNode != null && currentNode._id != nodeid) return; // The user has moved to another device
            addTab();
            var last = getstore('_curPluginPage', null); // What MeshCentral does after the hooks, for a tab that arrives late
            if (last != null && Q('p19ph-' + last) != null) pluginHandler.callPluginPage(last, Q('p19ph-' + last));
        };
        timer = setTimeout(function() { bus.off(onReply); }, 20000);
        bus.on(onReply);
        meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'rpc', method: 'tabAccess', args: { nodeId: nodeid }, reqId: reqId });
    };
    // Called by the refusal notice on the tab's page (a remembered yes that is no longer true): hide the tab's header
    obj.hideTab = function(nodeid) {
        try {
            if (typeof nodeid == 'string') (window.scripttaskTabAccess = window.scripttaskTabAccess || {})[nodeid] = { show: false, until: Date.now() + 60000 };
            var head = Q('p19ph-pluginScriptTask');
            if (head != null) head.style.display = 'none';
        } catch (e) { }
    };

    // One message bus per top window, created in the top window's realm so it outlives any plugin iframe.
    // Plugin iframes subscribe to it; replies and change notices from the server are fanned out to them.
    obj.getBus = function() {
        if (window.scripttaskBus == null) {
            var listeners = [];
            window.scripttaskBus = {
                on: function (fn) { listeners.push(fn); },
                off: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
                emit: function (type, msg) { listeners.slice().forEach(function (fn) { try { fn(type, msg); } catch (e) { } }); }
            };
        }
        return window.scripttaskBus;
    };
    obj.onRpcResult = function(server, message) {
        pluginHandler.scripttask.getBus().emit('rpc', message);
    };
    obj.onInvalidate = function(message) {
        pluginHandler.scripttask.getBus().emit('invalidate', message.event);
    };

    // ---- Queue ----

    // Built-in variables, filled in when a run is sent. Device details are read from MeshCentral only if the script uses them.
    var DEVICE_VARS = ['GBL:nodeName', 'GBL:meshName', 'GBL:tags', 'GBL:os'];
    // Device, group, tag, script and user names are typed by people and end up inside scripts, so a name could close a quote and add a command.
    // Characters that can do that are replaced with _ ; control characters are dropped and values are cut at 256 characters.
    function safeValue(v) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/["'`$;&|<>%^\\]/g, '_').substring(0, 256); }
    obj.safeValue = safeValue;
    obj.builtInVars = async function(job, script, names) {
        var agent = obj.meshServer.webserver.wsagents[job.node];
        var meshId = agent ? agent.dbMeshKey : null;
        var v = {
            'GBL:nodeId': job.node,
            'GBL:meshId': meshId,
            'GBL:runBy': safeValue(job.runBy || 'unknown'),
            'GBL:scriptName': safeValue(script.name),
            'GBL:runTime': new Date().toISOString()
        };
        if (DEVICE_VARS.some(function(n) { return names.indexOf(n) >= 0; })) {
            var node = await new Promise(function(resolve) { obj.meshServer.db.Get(job.node, function(err, docs) { resolve((docs && docs[0]) || null); }); });
            if (node != null && meshId == null) meshId = node.meshid;
            var meshes = obj.meshServer.webserver.meshes || {};
            v['GBL:nodeName'] = safeValue(node ? node.name : '');
            v['GBL:tags'] = safeValue((node && Array.isArray(node.tags)) ? node.tags.join(',') : '');
            v['GBL:os'] = safeValue(node ? node.osdesc : '');
            v['GBL:meshName'] = safeValue((meshId && meshes[meshId]) ? meshes[meshId].name : '');
        }
        return v;
    };

    obj.sending = new Set(); // Jobs being sent right now, so overlapping queue runs don't send one twice

    obj.queueRun = async function() {
        if (!obj.isActive()) return;
        if (obj.db == null || typeof obj.db.getPendingJobs != 'function') return; // The database didn't start (see db.js)
        try { await obj.expireJobs(); } catch (e) { console.log('PLUGIN: ScriptTask: Could not expire jobs: ', e); }
        var onlineAgents = Object.keys(obj.meshServer.webserver.wsagents);
        //obj.debug('ScriptTask', 'Queue Running', Date().toLocaleString(), 'Online agents: ', onlineAgents);

        return obj.db.getPendingJobs(onlineAgents)
        .then((jobs) => {
            if (jobs.length == 0) return;
            //@TODO check for a large number and use taskLimiter to queue the jobs
            jobs.forEach(job => {
                var key = String(job._id);
                if (obj.sending.has(key)) return;
                obj.sending.add(key);
                obj.db.get(job.scriptId)
                .then(async (script) => {
                    script = script[0];
                    if (script == null) {
                        // The script was deleted after this job was queued. Close the job instead of retrying it every minute.
                        await obj.db.update(job._id, { completeTime: Math.floor(new Date() / 1000), errorVal: 'Script no longer exists in the library.' });
                        obj.invalidate({ nodeIds: [job.node] });
                        return;
                    }
                    var foundVars = script.content.match(/#(.*?)#/g);
                    var replaceVars = {};
                    if (foundVars != null && foundVars.length > 0) {
                        var foundVarNames = [];
                        foundVars.forEach(fv => {
                            foundVarNames.push(fv.replace(/^#+|#+$/g, ''));
                        });

                        var limiters = {
                            scriptId: job.scriptId,
                            nodeId: job.node,
                            meshId: obj.meshServer.webserver.wsagents[job.node]['dbMeshKey'],
                            names: foundVarNames
                        };
                        var finvals = await obj.db.getVariables(limiters);
                        var ordering = { 'global': 0, 'script': 1, 'mesh': 2, 'node': 3 }
                        finvals.sort((a, b) => {
                            return (ordering[a.scope] - ordering[b.scope])
                              || a.name.localeCompare(b.name);
                        });
                        // Built-ins are the least specific values: a variable with the same name at any scope replaces them
                        Object.assign(replaceVars, await obj.builtInVars(job, script, foundVarNames));
                        finvals.forEach(fv => {
                            replaceVars[fv.name] = fv.value;
                        });
                        //console.log('FV IS', finvals);
                        //console.log('RV IS', replaceVars);
                    }
                    var dispatchTime = Math.floor(new Date() / 1000);
                    var settings = await obj.getSettings();
                    var jObj = {
                        action: 'plugin',
                        plugin: 'scripttask',
                        pluginaction: 'triggerJob',
                        jobId: job._id,
                        scriptId: job.scriptId,
                        replaceVars: replaceVars,
                        scriptHash: script.contentHash,
                        dispatchTime: dispatchTime,
                        maxRunSeconds: (settings.maxRunMinutes || 0) * 60 // The agent stops the script after this long; 0 means no limit
                    };
                    // Recorded as sent before sending: it is never sent again (see checkSentJobs)
                    var agent = obj.meshServer.webserver.wsagents[job.node];
                    if (agent == null) return;
                    await obj.db.update(job._id, { dispatchTime: dispatchTime });
                    try { agent.send(JSON.stringify(jObj)); }
                    catch (e) { await obj.db.update(job._id, { dispatchTime: null }); return; }
                    obj.invalidate({ nodeIds: [job.node] });
                })
                .catch(e => console.log('PLUGIN: ScriptTask: Could not dispatch job.', e))
                .then(() => { obj.sending.delete(key); });
            });
        })
        .then(() => {
            obj.cleanHistory();
            obj.pruneAccess();
            // Settings load after startup: pick up a non-default interval on the first check
            if (obj.settingsCache && obj.settingsCache.queueIntervalSeconds != obj.timerSeconds) obj.resetQueueTimer();
            return obj.ensureScheduleJobs().catch(e => console.log('PLUGIN: ScriptTask: Error managing job schedules: ', e));
        })
        .catch(e => { console.log('PLUGIN: ScriptTask: Queue Run Error: ', e); });
    };

    // Delete runs older than the retention setting, at most every 6 hours
    obj.lastCleanup = 0;
    obj.cleanHistory = function() {
        if (Date.now() - obj.lastCleanup < 6 * 3600 * 1000) return;
        obj.lastCleanup = Date.now();
        obj.getSettings().then(function(s) { return obj.db.deleteOldHistory(s.historyDays); })
        .catch(function(e) { console.log('PLUGIN: ScriptTask: History cleanup error: ', e); });
    };

    // ---- HTTP ----

    obj.downloadFile = function(req, res, user) {
        obj.hasPerm(user, 'manage').then(function(ok) {
            if (!ok) { res.sendStatus(401); return; }
            obj._downloadFile(req, res, user);
        }).catch(function() { if (!res.headersSent) res.sendStatus(401); });
    };
    obj._downloadFile = function(req, res, user) {
        var id = req.query.dl;
        if (typeof id != 'string' || id.length == 0 || id.length > 128) { res.sendStatus(400); return; }
        obj.db.get(id)
        .then(found => {
          if (found.length != 1 || found[0].type != 'script' || (isPrivatePath(found[0].path) && !obj.isFullAdmin(user))) { res.sendStatus(401); return; }
          var file = found[0];
          res.setHeader('Content-disposition', 'attachment; filename="' + file.name.replace(/["\\\r\n]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(file.name));
          res.setHeader('Content-type', 'text/plain');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.send(file.content);
        })
        .catch(function() { if (!res.headersSent) res.sendStatus(500); });
    };

    // The page's scripts and styles are served only to users who have passed a ScriptTask permission check (see noteAccess)
    obj.serveInclude = function(req, res, user) {
        if (!obj.hasAccess(user)) { res.sendStatus(403); return; }
        var path = req.query.path;
        if (typeof path != 'string' || !/^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-.]+)*\.(js|css)$/.test(path) || path.indexOf('..') !== -1) { res.sendStatus(404); return; }
        res.sendFile(path, { root: obj.INCLUDES, dotfiles: 'deny', maxAge: '1h' }, function (err) { if (err && !res.headersSent) res.sendStatus(404); });
    };

    // What a refused user sees. Fixed text only. On the device tab it also hides the tab's header.
    obj.deniedPage = function(message, hideNodeId) {
        var hide = '';
        if (hideNodeId !== undefined) { // The device tab: tell MeshCentral's page to hide the tab (the id is only used if it looks like a device id)
            var arg = (typeof hideNodeId == 'string' && /^[A-Za-z0-9@$_\/\-]{1,128}$/.test(hideNodeId)) ? JSON.stringify(hideNodeId) : '';
            hide = '<script>try { window.parent.pluginHandler.scripttask.hideTab(' + arg + '); } catch (e) { }</script>';
        }
        return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ScriptTask</title></head><body style="margin:1rem;font-family:sans-serif;background:transparent;color:#888">' + message + hide + '</body></html>';
    };

    // Whether a user may use ScriptTask on a device: the "Run scripts" permission on it (and its Remote Commands right), or a manager who can see it.
    // The device tab, its page and its requests all follow this.
    obj.canUseDeviceTab = async function(session, nodeId) {
        if (typeof nodeId != 'string' || nodeId.length == 0 || nodeId.length > 128 || session.domain == null) return false;
        var caps = await obj.getNodeCaps(session, nodeId);
        if (caps.node == null) return false;
        return caps.run === true || (await obj.hasPerm(session.user, 'manage')) === true;
    };

    // The device tab's page: for users with the "Run scripts" permission on that device (and its Remote Commands right), or managers who can see it
    obj.serveDeviceShell = function(req, res, user) {
        var nodeId = req.query.nodeid;
        var refuse = function() { if (!res.headersSent) res.status(403).send(obj.deniedPage('You don\'t have access to ScriptTask on this device.', (typeof nodeId == 'string') ? nodeId : null)); };
        var domain = (obj.meshServer.config && obj.meshServer.config.domains) ? obj.meshServer.config.domains[user.domain] : null;
        if (domain == null) { refuse(); return; }
        obj.canUseDeviceTab({ user: user, domain: domain }, nodeId)
        .then(function(ok) {
            if (ok !== true) { refuse(); return; }
            obj.noteAccess(user, true);
            res.render(obj.VIEWS + 'device', { version: obj.version });
        })
        .catch(refuse);
    };

    obj.handleAdminReq = function(req, res, user) {
        if (user == null) { res.sendStatus(401); return; }
        if (req.query.include == 1) return obj.serveInclude(req, res, user);
        if (req.query.user == 1) {
            if (req.query.dl != null) return obj.downloadFile(req, res, user);
            return obj.serveDeviceShell(req, res, user);
        }
        // The ScriptTask page, opened from My Server > Plugins (MeshCentral's goPlugin sends no other parameters)
        obj.hasPerm(user, 'manage').then(function(ok) {
            obj.noteAccess(user, ok === true);
            if (ok !== true) { res.status(403).send(obj.deniedPage('The ScriptTask page is for ScriptTask managers.')); return; }
            res.render(obj.VIEWS + 'server', { version: obj.version });
        }).catch(function() { if (!res.headersSent) res.status(403).send(obj.deniedPage('The ScriptTask page is for ScriptTask managers.')); });
    };

    // ---- Scheduling ----
    // Every active schedule has exactly one incomplete job: the run for its next slot. When that job finishes,
    // expires under the schedule's offline policy, or is cancelled, the next job is created for the first slot after it.
    // Slots that passed while a device was offline are never run as a backlog.

    obj.Schedule = require(__dirname + '/schedule.js');
    obj.SETTINGS_DEFAULTS = { skipGraceSeconds: 120, defaultOfflinePolicy: 'wait', defaultOfflineWindow: 7200, defaultAnchor: 'slot', historyDays: 90, staleMinutes: 30,
        queueIntervalSeconds: 60, pageSize: 50, scheduleStepMinutes: 5, indentPs1: '4', indentBat: '4', indentBash: '2', maxRunMinutes: 120 };
    var SCHEDULE_STEPS = [1, 5, 10, 15, 30, 60], INDENTS = ['2', '4', 'tab'];
    obj.settingsCache = null;
    obj.getSettings = function() {
        if (obj.settingsCache != null) return Promise.resolve(obj.settingsCache);
        return obj.db.getSettings().then(function(saved) {
            var s = Object.assign({}, obj.SETTINGS_DEFAULTS);
            Object.keys(obj.SETTINGS_DEFAULTS).forEach(function(k) { if (saved[k] != null) s[k] = saved[k]; });
            obj.settingsCache = s;
            return s;
        });
    };

    // Run schedule changes one at a time, so the queue tick and a finishing job can't both create a schedule's next job
    var scheduleChain = Promise.resolve();
    obj.serial = function(fn) {
        var p = scheduleChain.then(fn);
        scheduleChain = p.catch(function() { });
        return p;
    };

    // Record that a job's slot is over (it ran, was missed or was cancelled), so the schedule's next job comes after it
    obj.closeSlot = function(scheduleId, job, extra) {
        if (scheduleId == null) return Promise.resolve();
        var slot = (job.slot != null) ? job.slot : job.dontQueueUntil;
        return obj.db.update(scheduleId, Object.assign({ lastSlot: slot }, extra || {}));
    };

    // Give every active schedule (or just one) that has no incomplete job a job for its next slot
    obj.ensureScheduleJobs = function(scheduleId) {
        return obj.serial(async function() {
            var settings = await obj.getSettings();
            var schedules = await obj.db.getActiveSchedules(scheduleId);
            if (schedules.length == 0) return;
            var busy = await obj.db.getScheduleIdsWithIncompleteJobs();
            var now = Math.floor(Date.now() / 1000);
            for (var s of schedules) {
                if (busy.indexOf(String(s._id)) >= 0) continue;
                // Schedules from before this version only have nextRun, the slot of their last job
                var last = (s.lastSlot != null) ? s.lastSlot : s.nextRun;
                // A new schedule starts at its start time, with a few minutes' grace. Otherwise: the first slot after the last one, and not in the past.
                var from = (last != null) ? Math.max(last + 1, now) : Math.max(s.startAt, now - 300);
                var slot = obj.Schedule.nextSlot(s, from);
                if (slot == null) {
                    // Finished: a one-time run is done, or the end time has passed
                    await obj.db.removeJobSchedule(s._id);
                    obj.invalidate({ nodeIds: [s.node], scriptIds: [s.scriptId] });
                    continue;
                }
                var scripts = await obj.db.get(s.scriptId);
                if (scripts.length == 0) continue;
                await obj.db.addJob({ scriptId: String(s.scriptId), scriptName: scripts[0].name, node: s.node, runBy: s.scheduledBy, runById: s.scheduledById || null, dontQueueUntil: slot, slot: slot, expiresAt: obj.Schedule.expiresAt(s, slot, settings.skipGraceSeconds), jobSchedule: String(s._id), batchId: s.batchId || null });
                await obj.db.update(s._id, { nextRun: slot });
                obj.invalidate({ nodeIds: [s.node], scriptIds: [s.scriptId] });
            }
        });
    };

    // Close jobs that were never sent before their offline policy ran out. They show as Missed in history.
    obj.expireJobs = async function() {
        var now = Math.floor(Date.now() / 1000);
        var jobs = await obj.db.getExpiredJobs(now);
        for (var j of jobs) {
            await obj.db.update(j._id, { completeTime: now, missed: true });
            await obj.closeSlot(j.jobSchedule, j);
            obj.invalidate({ nodeIds: [j.node], scriptIds: [j.scriptId] });
        }
        return jobs.length;
    };

    // Start a device's due jobs as soon as it connects, instead of at the next minute's queue check
    obj.hook_agentCoreIsStable = function(agent) {
        clearTimeout(obj.connectTimer);
        obj.connectTimer = setTimeout(obj.queueRun, 3000); // One queue run for a burst of reconnecting devices
        if (agent && typeof agent.dbNodeKey == 'string') {
            obj.checkSentJobs(agent).catch(function(e) { console.log('PLUGIN: ScriptTask: Could not check sent jobs: ', e); });
            obj.invalidate({ nodeIds: [agent.dbNodeKey] });
        }
    };

    // Runs are sent once and never resent: rerunning after a reboot could repeat a script that rebooted the device.
    // When a device's agent reconnects, ask it which of the runs it was sent are still running. The agent answers
    // with jobsNotRunning, and those runs are recorded as interrupted. A result that arrives later still counts.
    obj.INTERRUPTED = 'Interrupted: the device or its agent restarted before the script reported a result. It was not run again.';
    obj.checkSentJobs = async function(agent) {
        if (!obj.isActive() || obj.db == null) return;
        var sent = (await obj.db.getIncompleteJobsForNode(agent.dbNodeKey)).filter(function(j) { return j.dispatchTime != null; });
        if (sent.length == 0) return;
        agent.send(JSON.stringify({ action: 'plugin', plugin: 'scripttask', pluginaction: 'checkJobs', jobIds: sent.map(function(j) { return String(j._id); }) }));
    };
    obj.markInterrupted = async function(agent, jobIds) {
        var now = Math.floor(Date.now() / 1000), changed = false;
        for (var jobId of (Array.isArray(jobIds) ? jobIds : []).slice(0, 1000)) {
            var job = (await obj.db.get(String(jobId)))[0];
            if (job == null || job.type != 'job' || job.node != agent.dbNodeKey || job.completeTime != null || job.dispatchTime == null) continue;
            await obj.db.update(job._id, { completeTime: now, errorVal: obj.INTERRUPTED, interrupted: true });
            // A scheduled run closes its slot as usual; the schedule carries on with its next one
            if (job.jobSchedule != null) { await obj.closeSlot(job.jobSchedule, job); await obj.ensureScheduleJobs(job.jobSchedule); }
            changed = true;
        }
        if (changed) obj.invalidate({ nodeIds: [agent.dbNodeKey] });
    };

    // ---- Change notices ----

    // Tell open ScriptTask pages that something changed, so they re-query what they show.
    // Notices carry ids only, never data. Device notices go only to users who can see that device.
    obj.invalidate = function(scopes) {
        var send = function(userIds, payload) {
            if (userIds.length == 0) return;
            obj.meshServer.DispatchEvent(userIds, obj, Object.assign({ nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'onInvalidate' }, payload));
        };
        try {
            var audience = obj.noticeAudience();
            if (audience.length == 0) return;
            if (scopes.library || scopes.variables || scopes.settings || (scopes.scriptIds && scopes.scriptIds.length)) {
                send(audience.map(function(u) { return u._id; }), { library: scopes.library === true, variables: scopes.variables === true, settings: scopes.settings === true, scriptIds: (scopes.scriptIds || []).map(String) });
            }
            (scopes.nodeIds || []).forEach(function(nodeId) {
                Promise.all(audience.map(function(u) { return obj.canSeeNodeCached(u, nodeId).then(function(ok) { return ok ? u._id : null; }); }))
                .then(function(ids) { send(ids.filter(function(x) { return x != null; }), { nodeIds: [nodeId] }); })
                .catch(function() { });
            });
        } catch (e) { console.log('PLUGIN: ScriptTask: Could not send change notices: ', e); }
    };

    // ---- Permissions ----

    obj.isFullAdmin = function(user) {
        return user != null && (user.siteadmin >>> 0) === SITERIGHT_FULLADMIN;
    };

    // The plugin handler is `parent`. Where MeshCentral keeps the permission functions can differ between versions.
    obj.permissionHosts = function() { return [obj.parent, obj.meshServer && obj.meshServer.pluginHandler]; };

    obj.registerPermissions = function() {
        if (obj._permsRegistered) return true;
        var hosts = obj.permissionHosts();
        for (var i = 0; i < hosts.length; i++) {
            if (hosts[i] != null && typeof hosts[i].registerPermissions == 'function') {
                try { hosts[i].registerPermissions('scripttask', obj.permissions); obj._permsRegistered = true; return true; }
                catch (e) { console.log('PLUGIN: ScriptTask: could not register plugin permissions: ' + (e.message || e)); }
            }
        }
        return false;
    };

    // Starts the permission lookup. Returns a Promise, or null when this MeshCentral has no permission API.
    // The call shape is detected, not assumed: on MeshCentral 1.3.1 the plugin name comes first.
    obj.permissionCall = function(user, ctx) {
        if (typeof obj.getAccessPermissions == 'function') {
            obj._permMode = 'plugin object: getAccessPermissions(user, context)';
            return Promise.resolve(obj.getAccessPermissions(user, ctx));
        }
        var hosts = obj.permissionHosts();
        for (var i = 0; i < hosts.length; i++) {
            var host = hosts[i];
            if (host == null || typeof host.getAccessPermissions != 'function') continue;
            var src = ''; try { src = Function.prototype.toString.call(host.getAccessPermissions); } catch (e) { }
            var m = src.match(/^[^(]*\(\s*([A-Za-z_$][\w$]*)/);
            var takesName = (m != null) && /^(plugin|pluginname|plugin_name|pluginid|shortname|name|id)$/i.test(m[1]);
            obj._permMode = takesName ? 'plugin handler: getAccessPermissions(pluginName, user, context)' : 'plugin handler: getAccessPermissions(user, context)';
            return Promise.resolve(takesName ? host.getAccessPermissions('scripttask', user, ctx) : host.getAccessPermissions(user, ctx));
        }
        return null;
    };

    obj.describePermissionApi = function() {
        if (typeof obj.getAccessPermissions == 'function') return 'getAccessPermissions on the plugin object';
        var hosts = obj.permissionHosts();
        for (var i = 0; i < hosts.length; i++) {
            if (hosts[i] != null && typeof hosts[i].getAccessPermissions == 'function') {
                var src = ''; try { src = Function.prototype.toString.call(hosts[i].getAccessPermissions).split('\n')[0].substring(0, 120); } catch (e) { }
                return 'getAccessPermissions on the plugin handler: ' + src;
            }
        }
        return 'no getAccessPermissions found';
    };

    // One log line per user, permission and device per minute (grants: per five minutes)
    obj._decisionLogged = {};
    obj.logDecision = function(granted, user, key, ctx, detail) {
        try {
            var k = (granted ? 'g|' : 'd|') + (user && user._id) + '|' + key + '|' + (ctx && ctx.nodeid), now = Date.now();
            if (obj._decisionLogged[k] != null && (now - obj._decisionLogged[k]) < (granted ? 300000 : 60000)) return;
            obj._decisionLogged[k] = now;
            console.log('PLUGIN: ScriptTask: permission "' + key + '" ' + (granted ? 'granted to ' : 'refused for ') + (user && (user.name || user._id)) +
                ' (siteadmin=' + (user && user.siteadmin) + ') on ' + ((ctx && (ctx.nodeid || ctx.meshid)) || 'global') + ' - ' + detail + ' [' + (obj._permMode || 'no API') + ']');
        } catch (e) { }
    };

    // Resolves true or false. Fails closed: an error, a missing API or an unexpected answer means false.
    // Full administrators are not assumed to pass; the log line shows siteadmin with each decision.
    obj.canUse = function(user, key, ctx) {
        try {
            if (user == null || obj.permissions[key] == null) return Promise.resolve(false);
            ctx = ctx || {};
            var call = obj._permsRegistered ? obj.permissionCall(user, ctx) : null;
            if (call == null) {
                // No permission API, or our permissions never registered (MeshCentral allows everything for an unregistered plugin)
                var admin = obj.isFullAdmin(user);
                obj.logDecision(admin, user, key, ctx, obj._permsRegistered ? 'no plugin permission API; only full administrators are allowed' : 'permissions are not registered; only full administrators are allowed');
                return Promise.resolve(admin);
            }
            return call.then(function(has) {
                var allowed = false, what;
                if (typeof has == 'function') { var r = has(key); allowed = (r === true); what = 'the permission check returned ' + String(r); }
                else if (has != null && typeof has == 'object') { var r2 = has[key]; allowed = (r2 === true); what = 'the permission object has ' + key + ' = ' + String(r2); }
                else what = 'getAccessPermissions returned ' + String(has);
                obj.logDecision(allowed, user, key, ctx, what);
                return allowed;
            }).catch(function(e) { obj.logDecision(false, user, key, ctx, 'permission check threw: ' + ((e && e.message) || e)); return false; });
        } catch (e) {
            obj.logDecision(false, user, key, ctx, 'permission check threw: ' + ((e && e.message) || e));
            return Promise.resolve(false);
        }
    };
    // Resolves true or false (it is asynchronous: always await it)
    obj.hasPerm = function(user, perm, nodeId, meshId) {
        return obj.canUse(user, perm, { nodeid: nodeId, meshid: meshId });
    };
    // Resolve what a user may do on one device: the plugin's "run" permission plus the device's Remote Commands right,
    // which is what MeshCentral itself requires to run commands on a device.
    obj.getNodeCaps = function(session, nodeId) {
        return new Promise(function(resolve) {
            obj.meshServer.webserver.GetNodeWithRights(session.domain, session.user, nodeId, function(node, rights, visible) {
                if (node == null || !visible) { resolve({ node: null, run: false }); return; }
                var remoteCommand = (rights & MESHRIGHT_REMOTECOMMAND) != 0;
                if (!remoteCommand) { resolve({ node: node, remoteCommand: false, run: false }); return; }
                obj.hasPerm(session.user, 'run', node._id, node.meshid).then(function(ok) { resolve({ node: node, remoteCommand: true, run: ok === true }); });
            });
        });
    };
    obj.requireManage = async function(session) {
        if (!(await obj.hasPerm(session.user, 'manage'))) throw new RpcError('Only ScriptTask managers can do this.');
    };
    obj.requireNode = async function(session, nodeId) {
        if (typeof nodeId != 'string') throw new RpcError('No device given.');
        var caps = await obj.getNodeCaps(session, nodeId);
        if (!caps.run) throw new RpcError('You don\'t have permission to run scripts on this device.');
        return caps.node;
    };
    // Users may change jobs and schedules they created. Managers may change any.
    obj.requireOwnerOrManage = async function(session, ownerId) {
        if (await obj.hasPerm(session.user, 'manage')) return;
        if (ownerId == null || ownerId != session.user._id) throw new RpcError('You can only change jobs and schedules you created.');
    };

    // ---- Who is allowed in ----
    // A user who passes a ScriptTask permission check (the page, or a request) is recorded for 8 hours after their last one.
    // Only recorded users are sent the page's scripts and styles and change notices. Refusing the ScriptTask page removes the record.
    var ACCESS_TTL = 8 * 3600 * 1000;
    obj.access = {};
    obj.noteAccess = function(user, ok) {
        if (user == null || typeof user._id != 'string') return;
        if (ok === true) obj.access[user._id] = Date.now(); else delete obj.access[user._id];
    };
    obj.hasAccess = function(user) {
        var t = (user != null) ? obj.access[user._id] : null;
        return t != null && (Date.now() - t) < ACCESS_TTL;
    };
    var seenCache = {};
    obj.pruneAccess = function() {
        var now = Date.now();
        Object.keys(obj.access).forEach(function(k) { if (now - obj.access[k] >= ACCESS_TTL) delete obj.access[k]; });
        Object.keys(seenCache).forEach(function(k) { if (seenCache[k].until < now) delete seenCache[k]; });
        Object.keys(obj._decisionLogged).forEach(function(k) { if (now - obj._decisionLogged[k] > 600000) delete obj._decisionLogged[k]; });
    };
    // Signed-in users (with a MeshCentral session now) who are recorded as allowed in ScriptTask
    obj.noticeAudience = function() {
        var web = obj.meshServer.webserver, out = [];
        if (web == null || web.wssessions == null || web.users == null) return out;
        Object.keys(web.wssessions).forEach(function(uid) { var u = web.users[uid]; if (u != null && obj.hasAccess(u)) out.push(u); });
        return out;
    };
    // Whether a user can see a device in MeshCentral, remembered for a minute
    obj.canSeeNodeCached = function(user, nodeId) {
        var k = user._id + '|' + nodeId, c = seenCache[k], now = Date.now();
        if (c != null && c.until > now) return Promise.resolve(c.ok);
        var domain = (obj.meshServer.config && obj.meshServer.config.domains) ? obj.meshServer.config.domains[user.domain] : null;
        if (domain == null) return Promise.resolve(false);
        return new Promise(function(resolve) {
            obj.meshServer.webserver.GetNodeWithRights(domain, user, nodeId, function(node, rights, visible) {
                var ok = node != null && visible === true;
                seenCache[k] = { ok: ok, until: Date.now() + 60000 };
                resolve(ok);
            });
        });
    };

    // ---- RPC ----

    function RpcError(message) { this.message = message; }

    // Output from a device is untrusted: kept as text, and no more than a million characters
    var MAX_OUTPUT = 1000000;
    function capOutput(v) {
        if (v == null) return null;
        v = (typeof v == 'string') ? v : String(v);
        return (v.length > MAX_OUTPUT) ? v.substring(0, MAX_OUTPUT) + '\n... (output cut off at 1,000,000 characters)' : v;
    }
    obj.capOutput = capOutput;

    function str(v, max) {
        if (typeof v != 'string') throw new RpcError('Invalid input.');
        v = v.trim();
        if (v.length == 0 || v.length > (max || 256)) throw new RpcError('Invalid input.');
        return v;
    }
    function id(v) { return str(v, 128); }
    // The device ids in a request: at most 5000, as in a saved set of devices
    function deviceList(v) {
        if (!Array.isArray(v)) return [];
        if (v.length > 5000) throw new RpcError('Too many devices at once. Choose 5000 or fewer.');
        return v.map(id);
    }
    function name(v) {
        v = str(v, 200);
        if (/[\/\\]/.test(v)) throw new RpcError('Names can\'t contain / or \\.');
        return v;
    }

    // With a session, a script or folder in the Private folder is "not found" for anyone but a full administrator
    function getOne(itemId, type, session) {
        return obj.db.get(id(itemId)).then(function(found) {
            if (found.length != 1 || (type != null && found[0].type != type)) throw new RpcError('Not found. It may have been deleted.');
            if (session != null && isPrivatePath(found[0].path) && !obj.canUsePrivate(session)) throw new RpcError('Not found. It may have been deleted.');
            return found[0];
        });
    }

    // ---- Private scripts ----
    // The Private folder (path "Private") holds scripts only full administrators can see, edit, run or schedule. Everything about them
    // (runs, schedules, batches, variables of the script) is hidden from everyone else, and they can't be moved out of it or into it,
    // so a private script never becomes shared by accident.
    var PRIVATE_ROOT = 'Private';
    function isPrivatePath(p) { return typeof p == 'string' && (p == PRIVATE_ROOT || p.indexOf(PRIVATE_ROOT + '/') === 0); }
    obj.isPrivatePath = isPrivatePath;
    obj.canUsePrivate = function(session) { return obj.isFullAdmin(session.user); };
    var privateCache = null;
    obj.resetPrivateCache = function() { privateCache = null; };
    obj.privateScriptIds = async function() {
        if (privateCache != null && privateCache.until > Date.now()) return privateCache.ids;
        var items = await obj.db.getByPathPrefix(PRIVATE_ROOT);
        var ids = new Set(items.filter(function(i) { return i.type == 'script'; }).map(function(i) { return String(i._id); }));
        privateCache = { ids: ids, until: Date.now() + 5000 };
        return ids;
    };
    // The script ids this user must not see: none for a full administrator
    obj.hiddenScripts = async function(session) {
        return obj.canUsePrivate(session) ? new Set() : obj.privateScriptIds();
    };
    // The Private folder is made the first time a full administrator opens the library
    obj.ensurePrivateRoot = function() {
        return obj.serial(async function() {
            var found = await obj.db.getByPath(PRIVATE_ROOT);
            if (!found.some(function(i) { return i.type == 'folder' && i.name == PRIVATE_ROOT; })) await obj.db.addFolder(PRIVATE_ROOT, PRIVATE_ROOT);
        });
    };
    function folderPath(folderId, session) {
        if (folderId == null) return Promise.resolve('Shared');
        return getOne(folderId, null, session).then(function(f) { return f.path; }); // A folder's path includes itself; a script's path is its folder
    }
    function cleanSchedule(sj) {
        if (sj == null || RECUR_TYPES.indexOf(sj.recur) === -1) throw new RpcError('Invalid schedule.');
        var startAt = Number(sj.startAt);
        if (!isFinite(startAt) || startAt <= 0) throw new RpcError('Choose a start time.');
        var sched = { recur: sj.recur, interval: null, daysOfWeek: [], startAt: Math.floor(startAt), endAt: null };
        if (sj.recur != 'once') {
            sched.interval = Math.floor(Number(sj.interval));
            if (!(sched.interval >= 1 && sched.interval <= 10000)) throw new RpcError('Interval must be a whole number of at least 1.');
            if (sj.endAt != null) {
                sched.endAt = Math.floor(Number(sj.endAt));
                if (!isFinite(sched.endAt) || sched.endAt <= sched.startAt) throw new RpcError('The end time must be after the start time.');
            }
        }
        if (sj.recur == 'weekly') {
            if (!Array.isArray(sj.daysOfWeek)) throw new RpcError('Choose at least one day.');
            sched.daysOfWeek = sj.daysOfWeek.map(Number).filter(function(d) { return d >= 0 && d <= 6; }).map(String);
            if (sched.daysOfWeek.length == 0) throw new RpcError('Choose at least one day.');
        }
        if (sj.recur == 'once' && sched.startAt < Math.floor(Date.now() / 1000) - 300) throw new RpcError('Choose a time in the future.');
        sched.offlinePolicy = (['wait', 'window', 'skip'].indexOf(sj.offlinePolicy) >= 0) ? sj.offlinePolicy : 'wait';
        sched.offlineWindow = null;
        if (sched.offlinePolicy == 'window') {
            sched.offlineWindow = Math.floor(Number(sj.offlineWindow));
            if (!(sched.offlineWindow >= 60 && sched.offlineWindow <= 30 * 86400)) throw new RpcError('The window must be between 1 minute and 30 days.');
        }
        // Shifting to the actual run time only makes sense for evenly repeating schedules
        sched.anchor = (sj.anchor == 'actual' && ['minutes', 'hourly', 'daily'].indexOf(sj.recur) >= 0) ? 'actual' : 'slot';
        sched.timezone = obj.Schedule.isValidZone(sj.timezone) ? sj.timezone : null;
        return sched;
    }

    obj.rpc = {};

    // Everything a device tab needs to start: what this user may do, and the device's connection state.
    obj.rpc.init = async function(args, session) {
        var caps = (args.nodeId != null) ? await obj.getNodeCaps(session, id(args.nodeId)) : { node: null, run: false, remoteCommand: false };
        var manage = await obj.hasPerm(session.user, 'manage'), allowed = manage === true || caps.run === true;
        if (allowed) obj.noteAccess(session.user, true);
        var out = {
            version: obj.version,
            user: { id: session.user._id, name: session.user.name },
            caps: { manage: manage, run: caps.run, remoteCommand: caps.remoteCommand === true, visible: caps.node != null, private: obj.canUsePrivate(session) },
            node: (!allowed || caps.node == null) ? null : { id: caps.node._id, online: obj.meshServer.webserver.wsagents[caps.node._id] != null }
        };
        if (allowed) out.settings = await obj.getSettings(); // Nothing but what the user may do for someone who isn't allowed in
        return out;
    };

    // The script tree. With a device given, the "run" permission is resolved for that device, so a grant made
    // on one device or device group works. Without one, only a global "run" or "manage" permission passes.
    obj.rpc.tree = async function(args, session) {
        if (args.nodeId != null) await obj.requireNode(session, args.nodeId);
        else if (!(await obj.hasPerm(session.user, 'run')) && !(await obj.hasPerm(session.user, 'manage'))) throw new RpcError('No access.');
        if (obj.canUsePrivate(session)) {
            await obj.ensurePrivateRoot();
            return obj.db.getScriptTree();
        }
        return (await obj.db.getScriptTree()).filter(function(i) { return !isPrivatePath(i.path); });
    };

    // Does this user get ScriptTask's tab on this device? (the page asks before it adds the tab)
    obj.rpc.tabAccess = async function(args, session) {
        var show = await obj.canUseDeviceTab(session, args.nodeId);
        if (show) obj.noteAccess(session.user, true);
        return { show: show };
    };

    obj.rpc.nodeData = async function(args, session) {
        var node = await obj.requireNode(session, args.nodeId);
        var hidden = await obj.hiddenScripts(session);
        var results = await Promise.all([
            obj.db.getIncompleteJobsForNode(node._id),
            obj.db.getJobSchedulesForNode(node._id),
            obj.db.getJobNodeHistory(node._id)
        ]);
        var shown = function(x) { return !hidden.has(String(x.scriptId)); };
        return { online: obj.meshServer.webserver.wsagents[node._id] != null, queue: results[0].filter(shown), schedules: results[1].filter(shown), history: results[2].filter(function(j) { return j.completeTime != null && shown(j); }) };
    };

    obj.rpc.runScript = async function(args, session) {
        var script = await getOne(args.scriptId, 'script', session);
        var nodeIds = deviceList(args.nodeIds);
        if (nodeIds.length == 0) throw new RpcError('No device given.');
        if (nodeIds.length > 1) await obj.requireManage(session);
        var allowed = await obj.allowedTargets(session, nodeIds), batchId = null, slot = null;
        if (args.batchId != null) {
            // Running again on some of a batch's devices: the new runs join that batch, replacing those devices' results
            await obj.requireManage(session);
            var batch = await obj.db.getBatch(String(args.batchId));
            if (batch == null || String(batch.scriptId) != String(script._id)) throw new RpcError('That batch can\'t be run again.');
            batchId = batch.batchId;
            if (batch.recurring) {
                // A scheduled batch is run again one occurrence (slot) at a time, and only on devices already in it. The new runs
                // carry that slot, so they replace those devices' results for it. The schedules themselves are not touched.
                slot = Number(args.slot);
                var batchJobs = await obj.db.getJobsForBatches([batch.batchId]);
                if (!(slot > 0) || slot > Math.floor(Date.now() / 1000) || !batchJobs.some(function(j) { return j.slot == slot; })) throw new RpcError('That run of the batch can\'t be run again.');
                allowed.accepted = allowed.accepted.filter(function(n) { return batch.nodeIds.indexOf(n) >= 0; });
            } else {
                var added = allowed.accepted.filter(function(n) { return batch.nodeIds.indexOf(n) < 0; });
                if (added.length) await obj.db.update(batch._id, { nodeIds: batch.nodeIds.concat(added) });
            }
        } else if (allowed.accepted.length > 1) {
            batchId = await obj.startBatch(session, script, allowed.accepted, args.name, false);
        }
        for (var nodeId of allowed.accepted) {
            var jobDoc = { scriptId: String(script._id), scriptName: script.name, node: nodeId, runBy: session.user.name, runById: session.user._id, batchId: batchId };
            if (slot != null) jobDoc.slot = slot; // Belongs to that occurrence of a scheduled batch, but not to a schedule (jobSchedule stays null)
            await obj.db.addJob(jobDoc);
        }
        if (allowed.accepted.length) {
            obj.resetQueueTimer();
            obj.queueRun();
            obj.invalidate({ nodeIds: allowed.accepted, scriptIds: [String(script._id)] });
        }
        return { accepted: allowed.accepted.length, refused: allowed.refused, batchId: batchId };
    };

    obj.rpc.addSchedule = async function(args, session) {
        var script = await getOne(args.scriptId, 'script', session);
        var sched = cleanSchedule(args.schedule);
        var nodeIds = deviceList(args.nodeIds);
        if (nodeIds.length == 0) throw new RpcError('No device given.');
        if (nodeIds.length > 1) await obj.requireManage(session);
        var allowed = await obj.allowedTargets(session, nodeIds);
        var batchId = (allowed.accepted.length > 1) ? await obj.startBatch(session, script, allowed.accepted, args.name, true, sched) : null;
        for (var nodeId of allowed.accepted) {
            var r = await obj.db.addJobSchedule(Object.assign({ scriptId: String(script._id), node: nodeId, scheduledBy: session.user.name, scheduledById: session.user._id, lastRun: null, nextRun: null, lastSlot: null, anchorAt: null, paused: false, batchId: batchId }, sched));
            await obj.ensureScheduleJobs(r.insertedId);
        }
        if (allowed.accepted.length) obj.invalidate({ nodeIds: allowed.accepted, scriptIds: [String(script._id)] });
        return { accepted: allowed.accepted.length, refused: allowed.refused, batchId: batchId };
    };

    // Cancel an incomplete job (permission already checked)
    obj.cancelJobDoc = async function(job, userName) {
        if (job.dispatchTime == null) {
            await obj.db.delete(job._id);
        } else {
            // Already sent to the device. Close it here; a late result from the agent is still recorded.
            await obj.db.update(job._id, { completeTime: Math.floor(new Date() / 1000), cancelled: true, errorVal: 'Cancelled by ' + userName + ' after it was sent to the device.' });
        }
        // Cancelling a schedule's run skips that occurrence; the schedule carries on with its next one
        if (job.jobSchedule != null) { await obj.closeSlot(job.jobSchedule, job); await obj.ensureScheduleJobs(job.jobSchedule); }
        obj.invalidate({ nodeIds: [job.node], scriptIds: [job.scriptId] });
    };

    // A run, schedule or batch of a private script is "not found" for users who may not see private scripts
    obj.assertVisibleScript = async function(session, scriptId) {
        if ((await obj.hiddenScripts(session)).has(String(scriptId))) throw new RpcError('Not found. It may have been deleted.');
    };

    obj.rpc.cancelJob = async function(args, session) {
        var job = await getOne(args.jobId, 'job');
        await obj.assertVisibleScript(session, job.scriptId);
        await obj.requireNode(session, job.node);
        await obj.requireOwnerOrManage(session, job.runById);
        if (job.completeTime != null) throw new RpcError('This job has already finished.');
        await obj.cancelJobDoc(job, session.user.name);
        return true;
    };

    obj.rpc.cancelAllPending = async function(args, session) {
        await obj.requireManage(session);
        var node = await obj.requireNode(session, args.nodeId);
        var jobs = await obj.db.getIncompleteJobsForNode(node._id), schedules = [];
        for (var job of jobs) {
            if (job.dispatchTime == null) await obj.db.delete(job._id);
            else await obj.db.update(job._id, { completeTime: Math.floor(new Date() / 1000), cancelled: true, errorVal: 'Cancelled by ' + session.user.name + ' after it was sent to the device.' });
            if (job.jobSchedule != null) { await obj.closeSlot(job.jobSchedule, job); schedules.push(job.jobSchedule); }
        }
        for (var sid of schedules) await obj.ensureScheduleJobs(sid);
        obj.invalidate({ nodeIds: [node._id] });
        return jobs.length;
    };

    obj.deleteScheduleDoc = async function(sched) {
        await obj.db.deletePendingJobsForSchedule(sched._id);
        await obj.db.delete(sched._id);
        obj.invalidate({ nodeIds: [sched.node], scriptIds: [sched.scriptId] });
    };

    obj.rpc.deleteSchedule = async function(args, session) {
        var sched = await getOne(args.scheduleId, 'jobSchedule');
        await obj.assertVisibleScript(session, sched.scriptId);
        await obj.requireNode(session, sched.node);
        await obj.requireOwnerOrManage(session, sched.scheduledById);
        await obj.deleteScheduleDoc(sched);
        return true;
    };

    obj.rpc.updateSchedule = async function(args, session) {
        var existing = await getOne(args.scheduleId, 'jobSchedule');
        await obj.assertVisibleScript(session, existing.scriptId);
        await obj.requireNode(session, existing.node);
        await obj.requireOwnerOrManage(session, existing.scheduledById);
        var sched = cleanSchedule(args.schedule);
        await obj.db.deleteUndispatchedJobsForSchedule(existing._id);
        // Start afresh from now: no run for a slot that has already passed
        await obj.db.update(existing._id, Object.assign(sched, { lastSlot: Math.floor(Date.now() / 1000), nextRun: null, anchorAt: null }));
        await obj.ensureScheduleJobs(existing._id);
        obj.invalidate({ nodeIds: [existing.node], scriptIds: [existing.scriptId] });
        return true;
    };

    // Give several schedules one new timetable (managers): the schedules in scheduleIds, or every schedule of a scheduled batch (batchId).
    // Each is treated like a single edit: its pending run is replaced and it restarts from now. Paused schedules stay paused.
    obj.rpc.updateSchedules = async function(args, session) {
        await obj.requireManage(session);
        var sched = cleanSchedule(args.schedule);
        var visible = await obj.visibleNodes(session), hidden = await obj.hiddenScripts(session);
        var found = [], skipped = 0, batch = null;
        if (args.batchId != null) {
            batch = await obj.db.getBatch(String(args.batchId));
            if (batch == null || !batch.recurring || hidden.has(String(batch.scriptId))) throw new RpcError('That batch has no schedule.');
            found = (await obj.db.getAllSchedules()).filter(function(s) { return s.batchId == batch.batchId; });
        } else {
            for (var sid of (Array.isArray(args.scheduleIds) ? args.scheduleIds : []).slice(0, 1000)) {
                var docs = await obj.db.get(String(sid));
                if (docs[0] == null || docs[0].type != 'jobSchedule') { skipped++; continue; }
                found.push(docs[0]);
            }
        }
        var now = Math.floor(Date.now() / 1000), updated = [], nodes = new Set(), scripts = new Set();
        for (var s of found) {
            if (!visible.has(s.node) || hidden.has(String(s.scriptId))) { skipped++; continue; }
            await obj.db.deleteUndispatchedJobsForSchedule(s._id);
            await obj.db.update(s._id, Object.assign({}, sched, { lastSlot: now, nextRun: null, anchorAt: null }));
            await obj.ensureScheduleJobs(s._id);
            updated.push(s); nodes.add(s.node); scripts.add(s.scriptId);
        }
        // A batch shows the timetable of its schedules: refresh it when all of the batch's schedules now have it
        var batchIds = new Set(updated.filter(function(s) { return s.batchId != null; }).map(function(s) { return s.batchId; }));
        if (batchIds.size) {
            var everything = (batch == null) ? await obj.db.getAllSchedules() : [], done = new Set(updated.map(function(s) { return String(s._id); }));
            for (var bid of batchIds) {
                var all = everything.filter(function(s) { return s.batchId == bid; });
                if (batch == null && !all.every(function(s) { return done.has(String(s._id)); })) continue;
                var bdoc = (batch != null && batch.batchId == bid) ? batch : await obj.db.getBatch(String(bid));
                if (bdoc != null) await obj.db.update(bdoc._id, { schedule: sched });
            }
        }
        if (updated.length) obj.invalidate({ nodeIds: Array.from(nodes), scriptIds: Array.from(scripts) });
        return { done: updated.length, skipped: skipped };
    };

    obj.pauseScheduleDoc = async function(existing, paused) {
        if (paused) {
            await obj.db.deleteUndispatchedJobsForSchedule(existing._id);
            await obj.db.update(existing._id, { paused: true, nextRun: null });
        } else {
            // Resume with the next slot from now; slots that passed while paused are skipped
            await obj.db.update(existing._id, { paused: false, lastSlot: Math.floor(Date.now() / 1000) });
            await obj.ensureScheduleJobs(existing._id);
        }
        obj.invalidate({ nodeIds: [existing.node], scriptIds: [existing.scriptId] });
    };

    obj.rpc.pauseSchedule = async function(args, session) {
        var existing = await getOne(args.scheduleId, 'jobSchedule');
        await obj.assertVisibleScript(session, existing.scriptId);
        await obj.requireNode(session, existing.node);
        await obj.requireOwnerOrManage(session, existing.scheduledById);
        await obj.pauseScheduleDoc(existing, args.paused === true);
        return true;
    };

    // -- Server-wide queue, schedules and history (managers) --

    // A run sent this long ago without a result is flagged (a setting; RPCs that use it load settings first)
    function staleSeconds() { return 60 * (obj.settingsCache ? obj.settingsCache.staleMinutes : obj.SETTINGS_DEFAULTS.staleMinutes); }
    var PAGE_MAX = 200;

    // Devices this user can see, out of those with ScriptTask jobs or schedules (plus extraIds).
    // Uses MeshCentral's own rights check per device, cached briefly per user.
    var visibleCache = {};
    obj.visibleNodes = async function(session, extraIds) {
        var key = session.user._id, cached = visibleCache[key];
        if (cached == null || cached.until < Date.now()) cached = visibleCache[key] = { nodes: new Set(), checked: new Set(), until: Date.now() + 30000 };
        // Devices seen for the first time since the cache started are checked now, so new jobs show straight away
        var ids = Array.from(new Set((await obj.db.getNodeIdsInUse()).concat(extraIds || []))).filter(function(id) { return !cached.checked.has(id); });
        await Promise.all(ids.map(function(nodeId) {
            cached.checked.add(nodeId);
            return new Promise(function(resolve) {
                obj.meshServer.webserver.GetNodeWithRights(session.domain, session.user, nodeId, function(node, rights, visible) { if (node != null && visible) cached.nodes.add(nodeId); resolve(); });
            });
        }));
        return cached.nodes;
    };
    function page(args) {
        return { skip: Math.max(0, Math.floor(Number(args.skip) || 0)), limit: Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(args.limit) || 50))) };
    }
    function cleanFilters(f) {
        f = (f != null && typeof f == 'object') ? f : {};
        var out = {};
        if (typeof f.scriptId == 'string' && f.scriptId) out.scriptId = f.scriptId.substring(0, 128);
        if (Array.isArray(f.nodeIds) && f.nodeIds.length) out.nodeIds = f.nodeIds.filter(function(n) { return typeof n == 'string'; }).slice(0, 5000);
        if (typeof f.runBy == 'string' && f.runBy.trim()) out.runBy = f.runBy.trim().substring(0, 128);
        if (typeof f.status == 'string' && f.status) out.status = f.status;
        if (f.source == 'manual' || f.source == 'schedule') out.source = f.source;
        if (Number(f.from) > 0) out.from = Math.floor(Number(f.from));
        if (Number(f.to) > 0) out.to = Math.floor(Number(f.to));
        if (typeof f.q == 'string' && f.q.trim()) out.q = f.q.trim().substring(0, 200);
        if (typeof f.batchId == 'string' && f.batchId) out.batchId = f.batchId.substring(0, 64);
        return out;
    }
    // A query for finished jobs on these devices. completeTime is a top-level range and the device list sits inside
    // $and, so NeDB (one index per query, top-level fields only) narrows by time; MongoDB uses its compound indexes.
    // A single device is a plain top-level match, which NeDB's node index handles best.
    function jobQuery(nodeIds, completeTime) {
        var find = { completeTime: completeTime, $and: [] };
        if (nodeIds.length == 1) find.node = nodeIds[0]; else find.$and.push({ node: { $in: nodeIds } });
        return find;
    }
    function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    // The devices a query may cover: the requested ones that this user can see
    function nodeScope(filters, visible) {
        var ids = filters.nodeIds ? filters.nodeIds.filter(function(n) { return visible.has(n); }) : Array.from(visible);
        return ids;
    }
    // A queued job's state, as the pages show it
    function queueStatus(j, now) {
        if (j.dispatchTime != null) return (now - j.dispatchTime > staleSeconds()) ? 'stale' : 'dispatched';
        if (j.expiresAt != null && j.expiresAt <= now) return 'missed';
        if (j.dontQueueUntil != null && j.dontQueueUntil > now) return 'scheduled';
        return (obj.meshServer.webserver.wsagents[j.node] != null) ? 'queued' : 'waiting';
    }

    obj.rpc.queue = async function(args, session) {
        await obj.requireManage(session);
        await obj.getSettings();
        var filters = cleanFilters(args.filters), p = page(args), now = Math.floor(Date.now() / 1000);
        var visible = await obj.visibleNodes(session), hidden = await obj.hiddenScripts(session);
        var nodes = new Set(nodeScope(filters, visible));
        var runBy = filters.runBy ? new RegExp(escapeRegex(filters.runBy), 'i') : null;
        var jobs = (await obj.db.getAllIncompleteJobs()).filter(function(j) {
            if (!nodes.has(j.node) || hidden.has(String(j.scriptId))) return false;
            if (filters.scriptId && j.scriptId != filters.scriptId) return false;
            if (filters.batchId && j.batchId != filters.batchId) return false;
            if (runBy && !runBy.test(j.runBy || '')) return false;
            if (filters.source == 'manual' && j.jobSchedule != null) return false;
            if (filters.source == 'schedule' && j.jobSchedule == null) return false;
            j.state = queueStatus(j, now);
            j.online = obj.meshServer.webserver.wsagents[j.node] != null;
            if (filters.status && j.state != filters.status) return false;
            return true;
        });
        // Running and overdue first, then by when they are due
        var order = { stale: 0, dispatched: 1, missed: 2, queued: 3, waiting: 4, scheduled: 5 };
        jobs.sort(function(a, b) { return (order[a.state] - order[b.state]) || ((a.dontQueueUntil || 0) - (b.dontQueueUntil || 0)); });
        return { total: jobs.length, jobs: jobs.slice(p.skip, p.skip + p.limit), staleSeconds: staleSeconds() };
    };

    obj.rpc.schedules = async function(args, session) {
        await obj.requireManage(session);
        var filters = cleanFilters(args.filters), p = page(args);
        var visible = await obj.visibleNodes(session), hidden = await obj.hiddenScripts(session);
        var nodes = new Set(nodeScope(filters, visible));
        var runBy = filters.runBy ? new RegExp(escapeRegex(filters.runBy), 'i') : null;
        var list = (await obj.db.getAllSchedules()).filter(function(s) {
            if (!nodes.has(s.node) || hidden.has(String(s.scriptId))) return false;
            if (filters.scriptId && s.scriptId != filters.scriptId) return false;
            if (filters.batchId && s.batchId != filters.batchId) return false;
            if (runBy && !runBy.test(s.scheduledBy || '')) return false;
            if (filters.status == 'paused' && s.paused !== true) return false;
            if (filters.status == 'active' && s.paused === true) return false;
            return true;
        });
        // Soonest first; paused last
        list.sort(function(x, y) { return ((x.paused === true) - (y.paused === true)) || ((x.nextRun == null) - (y.nextRun == null)) || ((x.nextRun || 0) - (y.nextRun || 0)); });
        return { total: list.length, schedules: list.slice(p.skip, p.skip + p.limit) };
    };

    obj.rpc.history = async function(args, session) {
        await obj.requireManage(session);
        var filters = cleanFilters(args.filters), p = page(args);
        var visible = await obj.visibleNodes(session), hidden = await obj.hiddenScripts(session);
        var find = jobQuery(nodeScope(filters, visible), { $gt: 0 }), and = find.$and;
        if (filters.from) find.completeTime.$gte = filters.from;
        if (filters.to) find.completeTime.$lte = filters.to;
        if (filters.scriptId) find.scriptId = filters.scriptId;
        if (filters.batchId) find.batchId = filters.batchId;
        if (filters.runBy) and.push({ runBy: { $regex: new RegExp(escapeRegex(filters.runBy), 'i') } });
        if (filters.source == 'manual') and.push({ jobSchedule: null });
        if (filters.source == 'schedule') and.push({ jobSchedule: { $ne: null } });
        switch (filters.status) {
            case 'missed': and.push({ missed: true }); break;
            case 'cancelled': and.push({ cancelled: true }); break;
            case 'error': and.push({ errorVal: { $ne: null } }, { returnVal: null }, { missed: { $ne: true } }, { cancelled: { $ne: true } }); break;
            case 'complete': and.push({ returnVal: { $ne: null } }, { cancelled: { $ne: true } }); break;
        }
        if (hidden.size) and.push({ scriptId: { $nin: Array.from(hidden) } });
        if (filters.q) { var re = new RegExp(escapeRegex(filters.q), 'i'); and.push({ $or: [ { returnVal: { $regex: re } }, { errorVal: { $regex: re } } ] }); }
        if (and.length == 0) delete find.$and; // MongoDB rejects an empty $and
        var results = await Promise.all([ obj.db.countJobs(find), obj.db.findJobs(find, { completeTime: -1 }, p.skip, p.limit) ]);
        // Lists carry the start of the output only; the full output comes from obj.rpc.job
        var jobs = results[1].map(function(j) {
            ['returnVal', 'errorVal'].forEach(function(k) { if (typeof j[k] == 'string' && j[k].length > 300) { j[k] = j[k].substring(0, 300); j.truncated = true; } });
            return j;
        });
        return { total: results[0], jobs: jobs };
    };

    // One job in full (for the output viewer): managers for devices they can see, or users who can run scripts on its device
    obj.rpc.job = async function(args, session) {
        var job = await getOne(args.id, 'job');
        await obj.assertVisibleScript(session, job.scriptId);
        if ((await obj.hasPerm(session.user, 'manage')) && (await obj.visibleNodes(session)).has(job.node)) return job;
        await obj.requireNode(session, job.node);
        return job;
    };

    obj.rpc.cancelJobs = async function(args, session) {
        await obj.requireManage(session);
        var visible = await obj.visibleNodes(session), hidden = await obj.hiddenScripts(session), done = 0, skipped = 0;
        for (var id of (Array.isArray(args.jobIds) ? args.jobIds : []).slice(0, 1000)) {
            var found = await obj.db.get(String(id));
            var job = found[0];
            if (job == null || job.type != 'job' || job.completeTime != null || !visible.has(job.node) || hidden.has(String(job.scriptId))) { skipped++; continue; }
            await obj.cancelJobDoc(job, session.user.name);
            done++;
        }
        return { done: done, skipped: skipped };
    };

    // Start queued or scheduled runs now instead of at their due time. Runs already sent are left alone.
    obj.rpc.runJobsNow = async function(args, session) {
        await obj.requireManage(session);
        var visible = await obj.visibleNodes(session), hidden = await obj.hiddenScripts(session), done = 0, skipped = 0, now = Math.floor(Date.now() / 1000), nodes = [];
        for (var id of (Array.isArray(args.jobIds) ? args.jobIds : []).slice(0, 1000)) {
            var found = await obj.db.get(String(id));
            var job = found[0];
            if (job == null || job.type != 'job' || job.completeTime != null || job.dispatchTime != null || !visible.has(job.node) || hidden.has(String(job.scriptId))) { skipped++; continue; }
            var update = { dontQueueUntil: now };
            if (job.expiresAt != null && job.expiresAt < now + 120) update.expiresAt = now + 120; // Don't let it expire before the queue gets to it
            await obj.db.update(job._id, update);
            nodes.push(job.node);
            done++;
        }
        if (done) { obj.queueRun(); obj.invalidate({ nodeIds: Array.from(new Set(nodes)) }); }
        return { done: done, skipped: skipped };
    };

    obj.rpc.scheduleAction = async function(args, session) {
        await obj.requireManage(session);
        if (['pause', 'resume', 'delete'].indexOf(args.action) === -1) throw new RpcError('Unknown action.');
        var visible = await obj.visibleNodes(session), hidden = await obj.hiddenScripts(session), done = 0, skipped = 0;
        for (var id of (Array.isArray(args.scheduleIds) ? args.scheduleIds : []).slice(0, 1000)) {
            var found = await obj.db.get(String(id));
            var sched = found[0];
            if (sched == null || sched.type != 'jobSchedule' || !visible.has(sched.node) || hidden.has(String(sched.scriptId))) { skipped++; continue; }
            if (args.action == 'delete') await obj.deleteScheduleDoc(sched);
            else if ((args.action == 'pause') != (sched.paused === true)) await obj.pauseScheduleDoc(sched, args.action == 'pause');
            done++;
        }
        return { done: done, skipped: skipped };
    };

    // -- Settings (managers) --

    obj.rpc.saveSettings = async function(args, session) {
        await obj.requireManage(session);
        // Fields left out keep their current values
        var before = await obj.getSettings();
        args = Object.assign({}, before, args);
        var s = {
            skipGraceSeconds: Math.floor(Number(args.skipGraceSeconds)),
            defaultOfflinePolicy: (['wait', 'window', 'skip'].indexOf(args.defaultOfflinePolicy) >= 0) ? args.defaultOfflinePolicy : 'wait',
            defaultOfflineWindow: Math.floor(Number(args.defaultOfflineWindow)),
            defaultAnchor: (args.defaultAnchor == 'actual') ? 'actual' : 'slot',
            historyDays: Math.floor(Number(args.historyDays)),
            staleMinutes: Math.floor(Number(args.staleMinutes)),
            queueIntervalSeconds: Math.floor(Number(args.queueIntervalSeconds)),
            pageSize: Math.floor(Number(args.pageSize)),
            scheduleStepMinutes: Number(args.scheduleStepMinutes),
            indentPs1: String(args.indentPs1), indentBat: String(args.indentBat), indentBash: String(args.indentBash),
            maxRunMinutes: Math.floor(Number(args.maxRunMinutes))
        };
        if (!(s.skipGraceSeconds >= 60 && s.skipGraceSeconds <= 3600)) throw new RpcError('The Skip grace period must be between 1 and 60 minutes.');
        if (!(s.historyDays >= 1 && s.historyDays <= 3650)) throw new RpcError('Keep history for between 1 and 3650 days.');
        if (!(s.staleMinutes >= 5 && s.staleMinutes <= 1440)) throw new RpcError('The "No result yet" time must be between 5 minutes and 24 hours.');
        if (!(s.queueIntervalSeconds >= 15 && s.queueIntervalSeconds <= 600)) throw new RpcError('The queue check interval must be between 15 seconds and 10 minutes.');
        if (!(s.pageSize >= 10 && s.pageSize <= 200)) throw new RpcError('Rows per page must be between 10 and 200.');
        if (!(s.maxRunMinutes >= 0 && s.maxRunMinutes <= 10080)) throw new RpcError('The maximum run time must be between 1 minute and 7 days, or 0 for no limit.');
        if (SCHEDULE_STEPS.indexOf(s.scheduleStepMinutes) < 0) throw new RpcError('Invalid schedule time step.');
        if ([s.indentPs1, s.indentBat, s.indentBash].some(function(v) { return INDENTS.indexOf(v) < 0; })) throw new RpcError('Invalid indentation.');
        if (!(s.defaultOfflineWindow >= 60 && s.defaultOfflineWindow <= 30 * 86400)) throw new RpcError('The default window must be between 1 minute and 30 days.');
        await obj.db.saveSettings(s);
        obj.settingsCache = null;
        if (s.historyDays < before.historyDays) { obj.lastCleanup = 0; obj.cleanHistory(); }
        if (s.queueIntervalSeconds != before.queueIntervalSeconds) { await obj.getSettings(); obj.resetQueueTimer(); }
        obj.invalidate({ settings: true });
        return obj.getSettings();
    };

    // -- Batches (managers) --

    // Which of these devices the user may run scripts on
    obj.allowedTargets = async function(session, nodeIds) {
        var accepted = [], refused = [];
        for (var nodeId of Array.from(new Set(nodeIds))) {
            var caps = await obj.getNodeCaps(session, nodeId);
            if (caps.run) accepted.push(nodeId); else refused.push(nodeId);
        }
        return { accepted: accepted, refused: refused };
    };
    obj.startBatch = async function(session, script, nodeIds, name, recurring, sched) {
        var batchId = require('crypto').randomBytes(9).toString('hex');
        await obj.db.addBatch({ batchId: batchId, name: (typeof name == 'string' && name.trim()) ? name.trim().substring(0, 120) : null, scriptId: String(script._id), scriptName: script.name,
            createdBy: session.user.name, createdById: session.user._id, createdAt: Math.floor(Date.now() / 1000), createdMs: Date.now(), nodeIds: nodeIds, recurring: recurring === true, schedule: sched || null });
        return batchId;
    };

    // A job's state for batch summaries: finished states, or the queue's states while pending
    function jobState(j, now) {
        if (j.completeTime == null) return queueStatus(j, now);
        if (j.cancelled) return 'cancelled';
        if (j.missed) return 'missed';
        return (j.errorVal != null && j.returnVal == null) ? 'error' : 'complete';
    }
    function jobOutput(j) {
        var v = (j.errorVal != null && j.returnVal == null) ? j.errorVal : j.returnVal;
        if (v == null) return '';
        return ((typeof v == 'string') ? v : JSON.stringify(v)).replace(/\r\n?/g, '\n').trim();
    }
    // A manual batch can have several runs per device after Run again; it shows each device's latest
    function latestPerNode(jobs) {
        var latest = {};
        jobs.forEach(function(j) {
            var cur = latest[j.node];
            // Runs queued in the same second: the unfinished one is the rerun
            if (cur == null || (j.queueTime || 0) > (cur.queueTime || 0) || ((j.queueTime || 0) == (cur.queueTime || 0) && cur.completeTime != null && j.completeTime == null)) latest[j.node] = j;
        });
        return latest;
    }
    function countStates(jobs, now) {
        var c = {};
        jobs.forEach(function(j) { var st = jobState(j, now); c[st] = (c[st] || 0) + 1; });
        return c;
    }
    // A scheduled batch's runs, one occurrence (slot) at a time: the latest one that has started, or the next one
    function slotsOf(jobs) {
        return Array.from(new Set(jobs.map(function(j) { return j.slot; }).filter(function(s) { return s != null; }))).sort(function(a, b) { return b - a; });
    }
    function currentSlot(slots, now) {
        var started = slots.filter(function(s) { return s <= now; });
        return started.length ? started[0] : (slots.length ? slots[slots.length - 1] : null);
    }

    obj.rpc.batches = async function(args, session) {
        await obj.requireManage(session);
        await obj.getSettings();
        var p = page(args), now = Math.floor(Date.now() / 1000);
        var hiddenIds = Array.from(await obj.hiddenScripts(session));
        var results = await Promise.all([obj.db.countBatches(hiddenIds), obj.db.getBatches(p.skip, p.limit, hiddenIds)]);
        var batches = results[1];
        var visible = await obj.visibleNodes(session, [].concat.apply([], batches.map(function(b) { return b.nodeIds; })));
        var jobs = batches.length ? await obj.db.getJobsForBatches(batches.map(function(b) { return b.batchId; })) : [];
        batches.forEach(function(b) {
            var mine = jobs.filter(function(j) { return j.batchId == b.batchId && visible.has(j.node); });
            if (b.recurring) { b.slot = currentSlot(slotsOf(mine), now); mine = mine.filter(function(j) { return j.slot == b.slot; }); }
            var latest = latestPerNode(mine);
            b.counts = countStates(Object.keys(latest).map(function(k) { return latest[k]; }), now);
            b.visibleDevices = b.nodeIds.filter(function(n) { return visible.has(n); }).length;
            b.deviceCount = b.nodeIds.length;
            b.nodeIds = b.nodeIds.filter(function(n) { return visible.has(n); }); // Ids of devices this user can't see aren't sent
        });
        return { total: results[0], batches: batches };
    };

    // One batch's results: devices grouped by identical output, and a row per device
    obj.rpc.batch = async function(args, session) {
        await obj.requireManage(session);
        await obj.getSettings();
        var batch = await obj.db.getBatch(String(args.batchId || ''));
        if (batch == null || (await obj.hiddenScripts(session)).has(String(batch.scriptId))) throw new RpcError('Batch not found.');
        var now = Math.floor(Date.now() / 1000);
        var visible = await obj.visibleNodes(session, batch.nodeIds);
        var jobs = (await obj.db.getJobsForBatches([batch.batchId])).filter(function(j) { return visible.has(j.node); });
        var slots = batch.recurring ? slotsOf(jobs) : [];
        var slot = null;
        if (batch.recurring) {
            slot = (args.slot != null && slots.indexOf(Number(args.slot)) >= 0) ? Number(args.slot) : currentSlot(slots, now);
            jobs = jobs.filter(function(j) { return j.slot == slot; });
        }
        var latest = latestPerNode(jobs);
        jobs = Object.keys(latest).map(function(k) { return latest[k]; });
        var groups = {}, rows = [];
        jobs.forEach(function(j) {
            var state = jobState(j, now), out = (j.completeTime != null) ? jobOutput(j) : '';
            var finished = ['complete', 'error'].indexOf(state) >= 0;
            var key = state + '\u0000' + (finished ? out : '');
            if (groups[key] == null) groups[key] = { state: state, output: finished ? out.substring(0, 4000) : '', truncated: finished && out.length > 4000, nodeIds: [], jobIds: [] };
            groups[key].nodeIds.push(j.node); groups[key].jobIds.push(j._id);
            rows.push({ jobId: j._id, node: j.node, state: state, queueTime: j.queueTime, dispatchTime: j.dispatchTime, completeTime: j.completeTime, output: (args.fullOutput === true) ? out : out.substring(0, 2000), outputLength: out.length });
        });
        // Most common result first; finished results before pending ones
        var order = { complete: 0, error: 0, missed: 1, cancelled: 1, stale: 2, dispatched: 3, queued: 4, waiting: 4, scheduled: 5 };
        var list = Object.keys(groups).map(function(k) { return groups[k]; }).sort(function(a, b) { return (order[a.state] - order[b.state]) || (b.nodeIds.length - a.nodeIds.length); });
        return { batch: Object.assign({}, batch, { nodeIds: batch.nodeIds.filter(function(n) { return visible.has(n); }), deviceCount: batch.nodeIds.length }), slots: slots, slot: slot, counts: countStates(jobs, now), groups: list, rows: rows,
            missing: batch.nodeIds.filter(function(n) { return visible.has(n) && latest[n] == null; }) };
    };

    // Devices of a list that exist in MeshCentral but that this user can't see (devices deleted from MeshCentral don't count)
    obj.unseenDevices = async function(session, nodeIds) {
        var visible = await obj.visibleNodes(session, nodeIds), out = [];
        for (var n of nodeIds) {
            if (visible.has(n)) continue;
            var exists = await new Promise(function(resolve) { obj.meshServer.db.Get(n, function(err, docs) { resolve(docs != null && docs.length == 1); }); });
            if (exists) out.push(n);
        }
        return out;
    };

    // Delete batches (managers). Their schedules are deleted and runs not yet sent are cancelled; runs already sent finish where they are.
    // Finished runs stay in History without the batch, or are deleted with it (args.deleteRuns). A batch that includes devices the
    // manager can't see is left alone, because deleting it would change schedules and runs on those devices.
    obj.rpc.deleteBatches = async function(args, session) {
        await obj.requireManage(session);
        var ids = (Array.isArray(args.batchIds) ? args.batchIds : []).slice(0, 100).map(function(b) { return String(b); });
        if (ids.length == 0) throw new RpcError('No batch given.');
        var hidden = await obj.hiddenScripts(session), done = 0, skipped = 0, reason = null;
        for (var bid of ids) {
            var batch = await obj.db.getBatch(bid);
            if (batch == null || hidden.has(String(batch.scriptId))) { skipped++; reason = reason || 'Batch not found. It may have been deleted.'; continue; }
            var unseen = await obj.unseenDevices(session, batch.nodeIds || []);
            if (unseen.length) { skipped++; reason = reason || 'This batch includes ' + unseen.length + (unseen.length == 1 ? ' device' : ' devices') + ' you can\'t see, so you can\'t delete it.'; continue; }
            var schedules = await obj.db.getSchedulesForBatch(batch.batchId);
            for (var sc of schedules) await obj.deleteScheduleDoc(sc);
            await obj.db.deleteUndispatchedJobsForBatch(batch.batchId);
            if (args.deleteRuns === true) await obj.db.deleteFinishedJobsForBatch(batch.batchId);
            await obj.db.detachJobsFromBatch(batch.batchId);
            await obj.db.delete(batch._id);
            obj.invalidate({ nodeIds: batch.nodeIds || [], scriptIds: [batch.scriptId] });
            done++;
        }
        return { done: done, skipped: skipped, reason: reason };
    };

    obj.rpc.targetSets = async function(args, session) {
        await obj.requireManage(session);
        return obj.db.getTargetSets(session.user._id);
    };
    obj.rpc.saveTargetSet = async function(args, session) {
        await obj.requireManage(session);
        var nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.filter(function(n) { return typeof n == 'string'; }).slice(0, 5000) : [];
        if (nodeIds.length == 0) throw new RpcError('Select some devices first.');
        await obj.db.saveTargetSet(session.user._id, str(args.name, 80), nodeIds);
        return obj.db.getTargetSets(session.user._id);
    };
    obj.rpc.deleteTargetSet = async function(args, session) {
        await obj.requireManage(session);
        var set = await getOne(args.id, 'targetSet');
        if (set.ownerId != session.user._id) throw new RpcError('Not found. It may have been deleted.');
        await obj.db.delete(set._id);
        return obj.db.getTargetSets(session.user._id);
    };

    // -- Library (managers) --

    obj.rpc.getScript = async function(args, session) {
        await obj.requireManage(session);
        return getOne(args.id, 'script', session);
    };

    obj.rpc.scriptData = async function(args, session) {
        await obj.requireManage(session);
        var script = await getOne(args.scriptId, 'script', session);
        var results = await Promise.all([obj.db.getJobScriptHistory(script._id), obj.db.getJobSchedulesForScript(script._id)]);
        return { history: results[0], schedules: results[1] };
    };

    obj.rpc.addScript = async function(args, session) {
        await obj.requireManage(session);
        if (FILE_TYPES.indexOf(args.filetype) === -1) throw new RpcError('Scripts must be PowerShell (.ps1), Batch (.bat) or Bash.');
        if (typeof args.content != 'string' || args.content.length > 4 * 1024 * 1024) throw new RpcError('Script content is missing or larger than 4 MB.');
        var path = await folderPath(args.folderId, session);
        var r = await obj.db.addScript(name(args.name), args.content, path, args.filetype);
        obj.resetPrivateCache();
        obj.invalidate({ library: true });
        return { id: r.insertedId };
    };

    obj.rpc.saveScript = async function(args, session) {
        await obj.requireManage(session);
        var script = await getOne(args.id, 'script', session);
        var filetype = (args.filetype != null) ? args.filetype : script.filetype;
        if (FILE_TYPES.indexOf(filetype) === -1) throw new RpcError('Unknown script type.');
        if (typeof args.content != 'string' || args.content.length > 4 * 1024 * 1024) throw new RpcError('Script content is missing or larger than 4 MB.');
        var newName = name(args.name);
        await obj.db.update(script._id, { name: newName, content: args.content, filetype: filetype });
        if (newName != script.name) await obj.db.updateScriptJobName(script._id, newName);
        obj.invalidate({ library: true, scriptIds: [script._id] });
        return true;
    };

    obj.rpc.newFolder = async function(args, session) {
        await obj.requireManage(session);
        var parentPath = await folderPath(args.parentId, session);
        var folderName = name(args.name);
        await obj.db.addFolder(folderName, parentPath + '/' + folderName);
        obj.invalidate({ library: true });
        return true;
    };

    obj.rpc.rename = async function(args, session) {
        await obj.requireManage(session);
        var item = await getOne(args.id, null, session);
        var newName = name(args.name);
        if (item.type == 'folder') {
            if (item.path == 'Shared' || item.path == PRIVATE_ROOT) throw new RpcError('The top-level folders can\'t be renamed.');
            var newPath = item.path.substring(0, item.path.length - item.name.length) + newName;
            await obj.db.rebasePath(item.path, newPath);
        } else if (item.type == 'script') {
            await obj.db.updateScriptJobName(item._id, newName);
        } else throw new RpcError('Only scripts and folders can be renamed.');
        await obj.db.update(item._id, { name: newName });
        obj.invalidate({ library: true, scriptIds: [item._id] });
        return true;
    };

    obj.rpc.move = async function(args, session) {
        await obj.requireManage(session);
        var item = await getOne(args.id, null, session);
        var target = await getOne(args.toId, 'folder', session);
        if (isPrivatePath(item.path) != isPrivatePath(target.path)) throw new RpcError('Private scripts stay in the Private folder, and nothing can be moved into it. Create or upload the script there instead.');
        if (item.type == 'folder') {
            if (item.path == 'Shared' || item.path == PRIVATE_ROOT) throw new RpcError('The top-level folders can\'t be moved.');
            if (target.path == item.path || target.path.indexOf(item.path + '/') === 0) throw new RpcError('A folder can\'t be moved into itself.');
            await obj.db.rebasePath(item.path, target.path + '/' + item.name);
        } else if (item.type == 'script') {
            await obj.db.update(item._id, { path: target.path });
        } else throw new RpcError('Only scripts and folders can be moved.');
        obj.invalidate({ library: true });
        return true;
    };

    obj.rpc.deleteItem = async function(args, session) {
        await obj.requireManage(session);
        var item = await getOne(args.id, null, session);
        var scripts = [];
        if (item.type == 'folder') {
            if (item.path == 'Shared' || item.path == PRIVATE_ROOT) throw new RpcError('The top-level folders can\'t be deleted.');
            var contents = await obj.db.getByPathPrefix(item.path);
            scripts = contents.filter(function(i) { return i.type == 'script'; });
            for (var c of contents) await obj.db.delete(c._id);
        } else if (item.type == 'script') {
            scripts = [item];
            await obj.db.delete(item._id);
        } else throw new RpcError('Only scripts and folders can be deleted.');
        for (var s of scripts) {
            var schedules = await obj.db.getJobSchedulesForScript(s._id);
            for (var sc of schedules) await obj.db.deletePendingJobsForSchedule(sc._id);
            await obj.db.deleteSchedulesForScript(s._id);
            await obj.db.deleteVariablesForScript(s._id);
        }
        obj.resetPrivateCache();
        obj.invalidate({ library: true, variables: true, scriptIds: scripts.map(function(s) { return s._id; }) });
        return true;
    };

    // -- Variables (managers) --

    function cleanVar(args) {
        var scopes = ['global', 'script', 'mesh', 'node'];
        if (scopes.indexOf(args.scope) === -1) throw new RpcError('Invalid scope.');
        var v = { name: str(args.name, 128), scope: args.scope, scopeTarget: (args.scope == 'global') ? null : id(args.scopeTarget), secret: args.secret === true };
        if (/[#\s]/.test(v.name)) throw new RpcError('Variable names can\'t contain spaces or #.');
        // A secret's value is left out of lists, so editing one without a new value keeps the old value
        if (args.value !== undefined) {
            v.value = (args.value == null) ? '' : String(args.value);
            if (v.value.length > 64 * 1024) throw new RpcError('Value is larger than 64 KB.');
        }
        return v;
    }
    // Managers only see and set variables for device groups and devices they can see
    obj.canSeeMesh = function(session, meshId) {
        if (obj.isFullAdmin(session.user) && typeof obj.meshServer.webserver.IsMeshViewable != 'function') return true;
        return typeof obj.meshServer.webserver.IsMeshViewable == 'function' && obj.meshServer.webserver.IsMeshViewable(session.user, meshId) === true;
    };
    obj.canSeeNode = function(session, nodeId) {
        return new Promise(function(resolve) {
            obj.meshServer.webserver.GetNodeWithRights(session.domain, session.user, nodeId, function(node, rights, visible) { resolve(node != null && visible === true); });
        });
    };
    // newTarget: the target is being set, so a script target must exist (an existing variable may outlive its script)
    async function checkVarTarget(session, v, newTarget) {
        if (v.scope == 'mesh' && !obj.canSeeMesh(session, v.scopeTarget)) throw new RpcError('Device group not found.');
        if (v.scope == 'node' && !(await obj.canSeeNode(session, v.scopeTarget))) throw new RpcError('Device not found.');
        if (v.scope == 'script' && (await obj.hiddenScripts(session)).has(String(v.scopeTarget))) throw new RpcError('Not found. It may have been deleted.');
        if (v.scope == 'script' && newTarget) await getOne(v.scopeTarget, 'script', session);
    }

    obj.rpc.variables = async function(args, session) {
        await obj.requireManage(session);
        var vars = await obj.db.getVariables(), out = [], nodeSeen = {}, hidden = await obj.hiddenScripts(session);
        for (var v of vars) {
            if (v.scope == 'script' && hidden.has(String(v.scopeTarget))) continue; // Variables of private scripts
            if (v.scope == 'mesh' && !obj.canSeeMesh(session, v.scopeTarget)) continue;
            if (v.scope == 'node') {
                if (nodeSeen[v.scopeTarget] == null) nodeSeen[v.scopeTarget] = await obj.canSeeNode(session, v.scopeTarget);
                if (!nodeSeen[v.scopeTarget]) continue;
            }
            if (v.secret === true) { v = Object.assign({}, v); delete v.value; }
            out.push(v);
        }
        return out;
    };
    obj.rpc.revealVar = async function(args, session) {
        await obj.requireManage(session);
        var v = await getOne(args.id, 'variable');
        await checkVarTarget(session, v);
        return v.value;
    };
    // Which library scripts use each variable name, as #name#
    obj.rpc.varUsage = async function(args, session) {
        await obj.requireManage(session);
        var hidden = await obj.hiddenScripts(session), usage = {}, re = /#([A-Za-z0-9_:.\-]+)#/g, m;
        (await obj.db.getScriptContents()).forEach(function(sc) {
            if (hidden.has(String(sc._id))) return;
            var seen = {};
            re.lastIndex = 0;
            while ((m = re.exec(sc.content || '')) != null) {
                if (seen[m[1]]) continue;
                seen[m[1]] = true;
                (usage[m[1]] = usage[m[1]] || []).push(sc._id);
            }
        });
        return usage;
    };
    obj.rpc.addVar = async function(args, session) {
        await obj.requireManage(session);
        var v = cleanVar(args);
        await checkVarTarget(session, v, true);
        var r = await obj.db.addVariable(v.name, v.scope, v.scopeTarget, v.value || '');
        if (v.secret) await obj.db.update(r.insertedId, { secret: true });
        obj.invalidate({ variables: true });
        return true;
    };
    obj.rpc.editVar = async function(args, session) {
        await obj.requireManage(session);
        var existing = await getOne(args.id, 'variable');
        await checkVarTarget(session, existing);
        var v = cleanVar(args);
        await checkVarTarget(session, v, v.scope != existing.scope || v.scopeTarget != existing.scopeTarget);
        if (v.value === undefined && existing.secret !== true) throw new RpcError('Invalid input.');
        await obj.db.update(existing._id, v);
        obj.invalidate({ variables: true });
        return true;
    };
    obj.rpc.deleteVar = async function(args, session) {
        await obj.requireManage(session);
        var existing = await getOne(args.id, 'variable');
        await checkVarTarget(session, existing);
        await obj.db.delete(existing._id);
        obj.invalidate({ variables: true });
        return true;
    };

    // -- Overview (managers) --

    obj.rpc.overview = async function(args, session) {
        await obj.requireManage(session);
        var settings = await obj.getSettings();
        var now = Math.floor(Date.now() / 1000), since = now - 86400;
        var visible = await obj.visibleNodes(session), nodes = Array.from(visible), hidden = await obj.hiddenScripts(session), hiddenIds = Array.from(hidden);
        var queue = (await obj.db.getAllIncompleteJobs()).filter(function(j) { return visible.has(j.node) && !hidden.has(String(j.scriptId)); });
        var counts = { queued: 0, waiting: 0, scheduled: 0, dispatched: 0, stale: 0, missed: 0 };
        queue.forEach(function(j) { j.state = queueStatus(j, now); counts[j.state]++; });
        // The last 24 hours, narrowed by completeTime first
        var recent = function(extra) { var q = jobQuery(nodes, { $gte: since }); q.$and = q.$and.concat(extra); if (hiddenIds.length) q.$and.push({ scriptId: { $nin: hiddenIds } }); return q; };
        var isFailed = [ { errorVal: { $ne: null } }, { returnVal: null }, { missed: { $ne: true } }, { cancelled: { $ne: true } } ];
        var failed = recent(isFailed), missed = recent([ { missed: true } ]);
        var completed = recent([ { returnVal: { $ne: null } }, { cancelled: { $ne: true } } ]);
        var r = await Promise.all([
            obj.db.countJobs(failed), obj.db.countJobs(missed), obj.db.countJobs(completed),
            obj.db.findJobs(recent([ { $or: [ { $and: isFailed }, { missed: true } ] } ]), { completeTime: -1 }, 0, 8),
            obj.db.getAllSchedules()
        ]);
        var schedules = r[4].filter(function(s) { return visible.has(s.node) && !hidden.has(String(s.scriptId)); });
        var trim = function(j) {
            ['returnVal', 'errorVal'].forEach(function(k) { if (typeof j[k] == 'string' && j[k].length > 300) j[k] = j[k].substring(0, 300); });
            return j;
        };
        return {
            now: now,
            staleSeconds: settings.staleMinutes * 60,
            queue: counts,
            day: { failed: r[0], missed: r[1], completed: r[2] },
            schedules: { active: schedules.filter(function(s) { return s.paused !== true && s.nextRun != null; }).length, paused: schedules.filter(function(s) { return s.paused === true; }).length },
            // Needs attention: recent errors and missed runs, and runs sent long ago without a result
            failures: r[3].map(trim),
            stale: queue.filter(function(j) { return j.state == 'stale'; }).sort(function(a, b) { return a.dispatchTime - b.dispatchTime; }).slice(0, 8),
            // Schedules' next runs, soonest first, including ones already due and waiting for their device
            upNext: queue.filter(function(j) { return j.jobSchedule != null && ['scheduled', 'queued', 'waiting'].indexOf(j.state) >= 0; }).sort(function(a, b) { return a.dontQueueUntil - b.dontQueueUntil; }).slice(0, 10)
        };
    };

    // Who may call each request. 'manage': checked here, before the handler runs. 'node': the handler resolves the
    // device and checks the "run" permission, the device's Remote Commands right and ownership. 'open': answers only
    // what the caller may do. A request that is not listed here is refused, so a new one can't go live ungated.
    obj.RPC_ACCESS = {
        init: 'open', tabAccess: 'open',
        tree: 'node', nodeData: 'node', runScript: 'node', addSchedule: 'node', cancelJob: 'node', deleteSchedule: 'node', updateSchedule: 'node', pauseSchedule: 'node', job: 'node',
        cancelAllPending: 'manage', queue: 'manage', schedules: 'manage', history: 'manage', cancelJobs: 'manage', runJobsNow: 'manage', scheduleAction: 'manage', updateSchedules: 'manage', saveSettings: 'manage',
        batches: 'manage', batch: 'manage', deleteBatches: 'manage', targetSets: 'manage', saveTargetSet: 'manage', deleteTargetSet: 'manage',
        getScript: 'manage', scriptData: 'manage', addScript: 'manage', saveScript: 'manage', newFolder: 'manage', rename: 'manage', move: 'manage', deleteItem: 'manage',
        variables: 'manage', revealVar: 'manage', varUsage: 'manage', addVar: 'manage', editVar: 'manage', deleteVar: 'manage', overview: 'manage'
    };
    obj.gateRpc = async function(method, session) {
        var level = Object.prototype.hasOwnProperty.call(obj.RPC_ACCESS, method) ? obj.RPC_ACCESS[method] : null;
        if (level == null) throw new RpcError('Unknown request.');
        if (level == 'manage') await obj.requireManage(session);
    };

    obj.handleRpc = function(command, session) {
        var reply = function(ok, data) {
            session.send({ action: 'plugin', plugin: 'scripttask', method: 'onRpcResult', reqId: command.reqId, ok: ok, data: ok ? data : undefined, error: ok ? undefined : data });
        };
        if (typeof command.method != 'string' || !Object.prototype.hasOwnProperty.call(obj.rpc, command.method)) { reply(false, 'Unknown request.'); return; }
        var args = (command.args != null && typeof command.args == 'object') ? command.args : {};
        Promise.resolve()
        .then(function() { return obj.gateRpc(command.method, session); })
        .then(function() { return obj.rpc[command.method](args, session); })
        .then(function(data) {
            if (obj.RPC_ACCESS[command.method] != 'open') obj.noteAccess(session.user, true); // Passed its permission check
            reply(true, data);
        })
        .catch(function(e) {
            if (e instanceof RpcError) { reply(false, e.message); return; }
            console.log('PLUGIN: ScriptTask: Error in ' + command.method + ': ', e);
            reply(false, 'Server error. See the MeshCentral log for details.');
        });
    };

    // ---- Messages from agents ----

    obj.agentAction = function(command, agent) {
        switch (command.pluginaction) {
            case 'getScript':
                // A device gets only a script it was sent a run for, and only what it needs to run it
                if (typeof command.scriptId != 'string' || command.scriptId.length == 0 || command.scriptId.length > 128) break;
                obj.db.getIncompleteJobsForNode(agent.dbNodeKey)
                .then(function(jobs) {
                    if (!jobs.some(function(j) { return j.dispatchTime != null && String(j.scriptId) == command.scriptId; })) return null;
                    return obj.db.get(command.scriptId);
                })
                .then(function(found) {
                    if (found == null || found.length != 1 || found[0].type != 'script') return;
                    var sc = found[0];
                    agent.send(JSON.stringify({
                        action: 'plugin',
                        plugin: 'scripttask',
                        pluginaction: 'cacheScript',
                        nodeid: agent.dbNodeKey,
                        rights: true,
                        sessionid: true,
                        script: { _id: sc._id, name: sc.name, filetype: sc.filetype, content: sc.content, contentHash: sc.contentHash }
                    }));
                })
                .catch(function(e) { console.log('PLUGIN: ScriptTask: Could not send a script to a device: ', e); });
            break;
            case 'jobComplete':
                //obj.debug('ScriptTask', 'jobComplete Triggered', JSON.stringify(command));
                if (typeof command.jobId != 'string' || command.jobId.length == 0 || command.jobId.length > 128) break;
                var jobId = command.jobId, retVal = capOutput(command.retVal), errVal = capOutput(command.errVal);
                var completeTime = Math.floor(new Date() / 1000);
                obj.db.get(jobId)
                .then(jobs => {
                    var job = jobs[0];
                    if (job == null || job.type != 'job' || job.node != agent.dbNodeKey) return; // Agents may only report their own jobs
                    // Only a run that was sent can report, once (a cancelled or interrupted run may still report late)
                    if (job.dispatchTime == null || (job.completeTime != null && !job.cancelled && !job.interrupted)) return;
                    var dispatchTime = job.dispatchTime; // The time the server recorded, not what the device says
                    var update = { completeTime: completeTime, returnVal: retVal, errorVal: errVal, dispatchTime: dispatchTime };
                    if (job.cancelled) { update.completeTime = job.completeTime; update.errorVal = job.errorVal; update.lateReturnVal = retVal; update.lateErrorVal = errVal; delete update.returnVal; }
                    if (job.interrupted) update.interrupted = false; // It finished after all: its real result replaces "Interrupted"
                    return obj.db.update(jobId, update)
                    .then(() => {
                        if (job.jobSchedule == null || job.cancelled || job.interrupted) return; // Its slot was closed when it was cancelled or interrupted
                        return obj.db.get(job.jobSchedule)
                        .then((found) => {
                            if (found.length == 0) return;
                            var extra = { lastRun: completeTime };
                            if (found[0].anchor == 'actual') extra.anchorAt = job.dispatchTime || dispatchTime; // Late runs move the schedule to when this run actually started
                            return obj.closeSlot(job.jobSchedule, job, extra)
                            .then(() => obj.ensureScheduleJobs(job.jobSchedule));
                        });
                    })
                    .then(() => {
                        obj.invalidate({ nodeIds: [job.node], scriptIds: [job.scriptId] });
                    });
                })
                .catch(e => { console.log('PLUGIN: ScriptTask: Failed to complete job. ', e); });
            break;
            case 'jobsNotRunning':
                obj.markInterrupted(agent, command.jobIds).catch(function(e) { console.log('PLUGIN: ScriptTask: Could not record interrupted jobs: ', e); });
            break;
            case 'clearAllPendingJobs':
                obj.db.deletePendingJobsForNode(agent.dbNodeKey)
                .then(() => { obj.invalidate({ nodeIds: [agent.dbNodeKey] }); });
            break;
        }
    };

    obj.serveraction = function(command, myparent, grandparent) {
        // Called for both user sessions (meshuser) and agent connections (meshagent). Only user sessions have a user.
        if (myparent.user == null) {
            if (typeof myparent.dbNodeKey == 'string') obj.agentAction(command, myparent);
            return;
        }
        if (command.pluginaction == 'rpc') { obj.handleRpc(command, myparent); return; }
        console.log('PLUGIN: ScriptTask: unknown action ' + String(command.pluginaction).replace(/[^\w.-]/g, '?').substring(0, 40));
    };

    return obj;
}