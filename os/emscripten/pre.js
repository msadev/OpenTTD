Module.arguments.push('-memscripten', '-vsdl');
Module['websocket'] = { url: function(host, port, proto) {
    /* Log all network connection attempts */
    console.log('[OpenTTD] Network connect: ' + host + ':' + port + ' (' + proto + ')');

    /* openttd.org hosts a WebSocket proxy for the content service. */
    if (host == "content.openttd.org" && port == 3978 && proto == "tcp") {
        console.log('[OpenTTD] -> Using official content proxy');
        return "wss://bananas-server.openttd.org/";
    }

    /* Check if a local WebSocket proxy is configured. */
    if (window.openttd_websocket_proxy) {
        /* Invite codes start with '+' - these need special handling via the proxy's
         * /invite/ endpoint which will resolve them and potentially use TURN relay. */
        if (host.startsWith('+')) {
            var url = window.openttd_websocket_proxy + '/invite/' + encodeURIComponent(host);
            console.log('[OpenTTD] -> Invite code via proxy: ' + url);
            return url;
        }
        var url = window.openttd_websocket_proxy + '/connect/' + host + '/' + port;
        console.log('[OpenTTD] -> Direct via proxy: ' + url);
        return url;
    }

    /* Everything else just tries to make a default WebSocket connection.
     * If you run your own server you can setup your own WebSocket proxy in
     * front of it and let people connect to your server via the proxy. You
     * are best to add another "if" statement as above for this. */

    if (location.protocol === 'https:') {
        /* Insecure WebSockets do not work over HTTPS, so we force
         * secure ones. */
        console.log('[OpenTTD] -> HTTPS mode, using wss://');
        return 'wss://';
    } else {
        /* Use the default provided by Emscripten. */
        console.log('[OpenTTD] -> Using default WebSocket');
        return null;
    }
} };

Module.preRun.push(function() {
    personal_dir = '/home/web_user/.openttd';
    content_download_dir = personal_dir + '/content_download'

    /* Because of the "-c" above, all user-data is stored in /user_data. */
    FS.mkdir(personal_dir);
    FS.mount(IDBFS, {}, personal_dir);

    Module.addRunDependency('syncfs');
    FS.syncfs(true, function (err) {
        Module.removeRunDependency('syncfs');
    });

    window.openttd_syncfs_shown_warning = false;
    window.openttd_syncfs = function(callback) {
        /* Copy the virtual FS to the persistent storage. */
        FS.syncfs(false, function (err) {
            /* On first time, warn the user about the volatile behaviour of
             * persistent storage. */
            if (!window.openttd_syncfs_shown_warning) {
                window.openttd_syncfs_shown_warning = true;
                Module.onWarningFs();
            }

            if (callback) callback();
        });
    }

    window.openttd_exit = function() {
        window.openttd_syncfs(Module.onExit);
    }

    window.openttd_abort = function() {
        window.openttd_syncfs(Module.onAbort);
    }

    window.openttd_bootstrap = function(current, total) {
        Module.onBootstrap(current, total);
    }

    window.openttd_bootstrap_failed = function() {
        Module.onBootstrapFailed();
    }

    window.openttd_bootstrap_reload = function() {
        window.openttd_syncfs(function() {
            Module.onBootstrapReload();
            setTimeout(function() {
                location.reload();
            }, 1000);
        });
    }

    window.openttd_server_list = function() {
        /* Use the new function that accepts full server info to avoid querying each server */
        var add_server_with_info = Module.cwrap("em_openttd_add_server_with_info", null, [
            "string",  /* connection_string */
            "string",  /* server_name */
            "string",  /* server_revision */
            "number",  /* clients_on */
            "number",  /* clients_max */
            "number",  /* companies_on */
            "number",  /* companies_max */
            "number",  /* spectators_on */
            "number",  /* map_width */
            "number",  /* map_height */
            "number",  /* landscape */
            "boolean", /* use_password */
            "boolean", /* dedicated */
            "number",  /* calendar_date */
            "number",  /* calendar_start */
            "number",  /* ticks_playing (double in C++, converted to uint64) */
            "string",  /* gamescript_name */
            "number"   /* gamescript_version */
        ]);

        /* Landscape type mapping */
        var landscapeTypes = {
            'Temperate': 0,
            'Arctic': 1,
            'Tropical': 2,
            'Toyland': 3
        };

        /* Fetch server list from proxy on demand (when Search Internet is clicked) */
        if (window.openttd_websocket_proxy) {
            var proxyUrl = window.openttd_websocket_proxy.replace('ws://', 'http://').replace('wss://', 'https://');
            console.log('[OpenTTD] Fetching server list from proxy...');

            fetch(proxyUrl + '/servers')
                .then(function(response) { return response.json(); })
                .then(function(servers) {
                    console.log('[OpenTTD] Got ' + servers.length + ' servers from proxy');
                    servers.forEach(function(server) {
                        add_server_with_info(
                            server.connection_string,
                            server.name || 'Unknown Server',
                            server.version || '',
                            server.clients_on || 0,
                            server.clients_max || 0,
                            server.companies_on || 0,
                            server.companies_max || 0,
                            server.spectators_on || 0,
                            server.map_width || 256,
                            server.map_height || 256,
                            landscapeTypes[server.landscape] || 0,
                            server.password || false,
                            server.dedicated || false,
                            server.calendar_date || 0,
                            server.calendar_start || 0,
                            server.ticks_playing || 0,
                            server.gamescript_name || '',
                            server.gamescript_version || -1
                        );
                    });
                })
                .catch(function(err) {
                    console.log('[OpenTTD] Failed to fetch server list:', err);
                });
        }
    }

    var leftButtonDown = false;
    document.addEventListener("mousedown", e => {
        if (e.button == 0) {
            leftButtonDown = true;
        }
    });
    document.addEventListener("mouseup", e => {
        if (e.button == 0) {
            leftButtonDown = false;
        }
    });
    window.openttd_open_url = function(url, url_len) {
        const url_string = UTF8ToString(url, url_len);
        function openWindow() {
            document.removeEventListener("mouseup", openWindow);
            window.open(url_string, '_blank');
        }
        /* Trying to open the URL while the mouse is down results in the button getting stuck, so wait for the
         * mouse to be released before opening it. However, when OpenTTD is lagging, the mouse can get released
         * before the button click even registers, so check for that, and open the URL immediately if that's the
         * case. */
        if (leftButtonDown) {
            document.addEventListener("mouseup", openWindow);
        } else {
            openWindow();
        }
    }

    /* https://github.com/emscripten-core/emscripten/pull/12995 implements this
    * properly. Till that time, we use a polyfill. */
   SOCKFS.websocket_sock_ops.createPeer_ = SOCKFS.websocket_sock_ops.createPeer;
   SOCKFS.websocket_sock_ops.createPeer = function(sock, addr, port)
   {
       let func = Module['websocket']['url'];
       Module['websocket']['url'] = func(addr, port, (sock.type == 2) ? 'udp' : 'tcp');
       let ret = SOCKFS.websocket_sock_ops.createPeer_(sock, addr, port);
       Module['websocket']['url'] = func;
       return ret;
   }
});
