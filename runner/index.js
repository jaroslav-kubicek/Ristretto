var fs = require('fs');
var cp = require('child_process');
var express = require('express');
var http = require('http');
var colors = require('colors');
var FileWatcher = require('./filewatcher');
var path = require('path');

var config = {};
if(fs.existsSync('ristretto.json'))
	config = JSON.parse(fs.readFileSync('ristretto.json'));

config.append_script = fs.readFileSync(__dirname + '/reload_snippet.html') || '';

var host = config.host || '0.0.0.0';
var port = config.port || 2012;

var action = process.argv[2];

if(['update', 'install', 'init'].indexOf(action) !== -1) {
	var p1 = path.relative(process.cwd, __dirname);
	var p2 = path.relative(p1, config.www_dir);

	var commands = [];
	if(['install', 'init'].indexOf(action) !== -1) {
		commands.push({
			'label': 'Installing globally LESS, Bower and Test\'em',
			'cwd': __dirname,
			'cmd': 'npm install -g less bower testem'
		});
	}
	commands.push({
		'label': 'Updating Composer',
		'cwd': __dirname,
		'cmd': 'php composer.phar update'
	});
	commands.push({
		'label': 'Updating NPM',
		'cwd': __dirname,
		'cmd': 'npm update'
	});
	if(fs.existsSync(config.www_dir)) {
		commands.push({
			'label': 'Updating Bower',
			'cwd': config.www_dir,
			'cmd': 'bower update'
		});
	}

	var update_next = function() {
		var cmd = commands.shift();
		if(!cmd) return;

		var update = cp.exec('cd "'+cmd.cwd+'" && '+cmd.cmd, function(err, stdout, stderr){
			console.log('DONE: %s'.blue, cmd.label);
			console.log('');
			update_next();
		});

		console.log('%s'.yellow, cmd.label);

		update.stdout.setEncoding('UTF-8');
		update.stderr.setEncoding('UTF-8');

		update.stdout.pipe(process.stdout);

		update.stderr.pipe(process.stderr);

		update.on('exit', function(data){
		});
	};
	update_next();
} else {
	var app = express();
	var server = app.listen(port);
	var io = require('socket.io').listen(server);

	io.set('log level', 1);

	console.log('[%s]', host+':'+port);

	app.configure(function(){
	  app.use(express.favicon(config.www_dir + '/img/favicon.ico'));
	  app.use(express.logger('dev'));
	  app.use(express['static'](config.www_dir));
	  app.use(express.bodyParser());
	  app.use(express.methodOverride());
	});

	app.use(function(req, res) {
		var path = req.originalUrl.substr(1);

		var parts = path.split('\/');
		var last = parts.pop();
		if(last === '') {
			parts.push('index');
			path = parts.join('/');
		}

		var hostname = req.headers.host.split(':').shift();

		var php = cp.spawn('php', [__dirname + '/app/index.php', '-l', path]);

		php.stdout.setEncoding('UTF-8');

		php.stdout.on('data', function(data){
			res.write(data);
		});

		php.stderr.on('data', function(data){
			res.write(data);
		});

		php.on('exit', function(code){
			setTimeout(function(){
				// to-do: check if html
				res.end(config.append_script);
			}, 30);
		});
	});

	var connections = {};
	var last_cid = 0;
	io.sockets.on('connection', function (socket) {
		var cid = last_cid++;
		connections[cid] = socket;
		socket.on('disconnect', function(){
			delete(connections[cid]);
		});
	});

	var dirtyState = false;
	var compilations = 0;
	var reloadConnections = function() {
		if(dirtyState && compilations === 0) {
			var count = 0;
			for(var k in connections) {
				connections[k].emit('reload stylesheets');
				count++;
			}
			console.log('RELOADING', count, (count > 1) ? 'PAGES' : 'PAGE');
			dirtyState = false;
		}
	};
	setInterval(reloadConnections, 100);

	(function() {
		var files = {
			//	'input.less': 'output.css'
		};

		files[config.www_dir + '/less/screen.less'] = config.www_dir + '/css/screen.css';

		var interval = 100; // ms
		var dirty = true;

		var compile = function(input, output) {
			compilations++;
			dirtyState = true;
			cp.exec('lessc -x ' + input + ' > ' + output, function(error, stdout, stderr) {
				if(stdout) console.log('%s', stdout);
				if(stderr) console.log('ERROR: %s'.red, stderr);
				if(!error) console.log('LESS COMPILED | %s'.yellow, new Date().toLocaleTimeString());
				setTimeout(function(){
					compilations--;
					compilations = Math.max(0, compilations);
				}, 20);
				
			});
		};

		var compileAll = function() {
				for(var key in files) {
					compile(key, files[key]);
				}
			};

		var fw = new FileWatcher();

		var reloadDirs = function() {
			fw.add(config.www_dir+"/less/**");
			compileAll();
		};
		reloadDirs();
		fw.on('change', function(file){
			compileAll();
			fs.stat(file, function(err, stat){
				if(stat.isDirectory()) {
					reloadDirs();
				}
			});
		});

	})();

	(function() {
		var ignore = [".git"];

		var interval = 100; // ms

		var check = function(file) {
			var filename = file.split('\/').pop().split('\\').pop();
			if(ignore.indexOf(filename) === -1) {
				dirtyState = true;
				console.log("CHANGED: %s".yellow, file);
			}
			fs.stat(file, function(err, stat){
				if(stat.isDirectory()) {
					reloadDirs();
				}
			});
		};

		var fw = new FileWatcher();

		var reloadDirs = function() {
			fw.add(config.www_dir+"/**");
			fw.add(config.latte_dir+"/**");
			fw.add(config.model_dir+"/**");
		};
		reloadDirs();

		fw.on('change', check);
	})();
}