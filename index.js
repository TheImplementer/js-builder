var gulp = require('gulp');
var gutil = require('gulp-util');
var jasmine = require('gulp-jasmine');
var jasmineReporters = require('jasmine-reporters');
var browserify = require('browserify');
var source = require('vinyl-source-stream');
var transformTools = require('browserify-transform-tools');
var _string = require('underscore.string');
var fs = require('fs');
var testWebServer;

var cwd = process.cwd();
var isMavenBuild = fs.existsSync(cwd + '/pom.xml');

var bundles = []; // see exports.bundle function

var adjunctBasePath = './target/generated-adjuncts/';
var jsmodulesBasePath = './target/classes/assets/';

var srcPaths;
var testSrcPath;
if (isMavenBuild) {
    gutil.log(gutil.colors.green("Maven project"));
    srcPaths = ['src/main/js','src/main/less'];
    testSrcPath = 'src/test/js';    
} else {
    srcPaths = ['./js', './less'];
    testSrcPath = './spec';    
}
gutil.log(gutil.colors.green(" - src: " + srcPaths));
gutil.log(gutil.colors.green(" - test: " + testSrcPath));

exports.gulp = gulp;
exports.browserify = browserify;

exports.defineTasks = function(tasknames) {
    if (!tasknames) {
        tasknames = ['test'];
    }
    
    var defaults = [];
    
    for (var i = 0; i < tasknames.length; i++) {
        var taskname = tasknames[i];
        var gulpTask = tasks[taskname];
        
        if (!gulpTask) {
            throw "Unknown gulp task '" + taskname + "'.";
        }
        
        exports.defineTask(taskname, gulpTask);
        if (taskname === 'jshint' || taskname === 'test' || taskname === 'bundle') {
            defaults.push(taskname);
        }
    }
    
    if (defaults.length > 0) {
        exports.logInfo('Setting defaults');
        gulp.task('default', defaults);
    }    
};

exports.defineTask = function(taskname, gulpTask) {
    if (taskname === 'test') {
        // Want to make sure the 'bundle' task gets run with the 'test' task.
        gulp.task('appTest', gulpTask);
        gulp.task('test', ['bundle', 'appTest']);
    } else {
        gulp.task(taskname, gulpTask);
    }
};

exports.src = function(paths) {
    if (paths) {
        srcPaths = [];
        if (typeof paths === 'string') {
            srcPaths.push(normalizePath(paths));
        } else if (paths.constructor === Array) {
            for (var i = 0; i < paths.length; i++) {
                srcPaths.push(normalizePath(paths[i]));
            }
        }
    }
    return srcPaths;
};

exports.tests = function(path) {
    if (path) {
        testSrcPath = normalizePath(path);
    }
    return testSrcPath;
};

exports.startTestWebServer = function(config) {
    _stopTestWebServer();
    _startTestWebServer(config);
    exports.logInfo("\t(call require('gulp').emit('testing_completed') when testing is completed - watch async test execution)");
};

exports.onTaskStart = function(taskName, callback) {
    gulp.on('task_start', function(event) {
        if (event.task === taskName) {
            callback();
        }
    });
};

exports.onTaskEnd = function(taskName, callback) {
    gulp.on('task_end', function(event) {
        if (event.task === taskName) {
            callback();
        }
    });
};

function normalizePath(path) {
    path = _string.ltrim(path, './')
    path = _string.ltrim(path, '/')
    path = _string.rtrim(path, '/');
    
    return path;
}
function packageToPath(packageName) {
    return _string.replaceAll(packageName, '\\.', '/');
}

exports.bundle = function(moduleToBundle, as) {
    if (!moduleToBundle) {
        gutil.log(gutil.colors.red("Error: Invalid bundle registration for module 'moduleToBundle' must be specify."));
        throw "'bundle' registration failed. See error above.";
    }

    var bundle = {};

    bundle.js = _string.strRightBack(moduleToBundle, '/'); // The short name of the javascript file (with extension but without path) 
    bundle.module = _string.strLeftBack(bundle.js, '.js'); // The short name with the .js extension removed
    bundle.bundleDependencyModule = (moduleToBundle === bundle.module); // The specified module to bundle is the name of a module dependency.
    
    if (!as) {
        bundle.as = bundle.module;
    } else {
        bundle.as = _string.strLeftBack(as, '.js');
    }
    
    function assertBundleOutputUndefined() {
        if (bundle.bundleInDir || bundle.bundleAsJenkinsModule || bundle.bundleToAdjunctPackageDir) {
            gutil.log(gutil.colors.red("Error: Invalid bundle registration. Bundle output (inAdjunctPackage, inDir, asJenkinsModuleResource) already defined."));
            throw "'bundle' registration failed. See error above.";
        }
    }

    bundle.bundleModule = moduleToBundle;
    bundle.bundleOutputFile = bundle.as + '.js';
    bundle.moduleMappings = [];
    bundle.inAdjunctPackage = function(packageName) {
        if (!packageName) {
            gutil.log(gutil.colors.red("Error: Invalid bundle registration for module '" + moduleToBundle + "'. You can't specify a 'null' adjunct package name."));
            throw "'bundle' registration failed. See error above.";
        }
        assertBundleOutputUndefined();
        bundle.bundleToAdjunctPackageDir = packageToPath(packageName);
        gutil.log(gutil.colors.green("Bundle will be generated as an adjunct in '" + adjunctBasePath + "' as '" + packageName + "." + bundle.as + "' (it's a .js file)."));
        return bundle;
    };
    bundle.inDir = function(dir) {
        if (!dir) {
            gutil.log(gutil.colors.red("Error: Invalid bundle registration for module '" + moduleToBundle + "'. You can't specify a 'null' dir name when calling inDir."));
            throw "'bundle' registration failed. See error above.";
        }
        assertBundleOutputUndefined();
        bundle.bundleInDir = normalizePath(dir);
        gutil.log(gutil.colors.green("Bundle will be generated in directory '" + bundle.bundleInDir + "' as '" + bundle.js + "'."));
        return bundle;
    };
    bundle.asJenkinsModuleResource = function() {
        assertBundleOutputUndefined();
        bundle.bundleAsJenkinsModule = true;
        gutil.log(gutil.colors.green("Bundle will be generated as a Jenkins Module in '" + jsmodulesBasePath + "' as '" + bundle.as + "'."));            
        return bundle;
    };
    bundle.withTransforms = function(transforms) {
        bundle.bundleTransforms = transforms;
        return bundle;
    };
    bundle.withExternalModuleMapping = function(from, to, require) {
        if (!from || !to) {
            var message = "Cannot call 'withExternalModuleMapping' without defining both 'to' and 'from' module names.";
            exports.logError(message);
            throw message;
        }
        
        // special case because we are externalizing handlebars runtime for handlebarsify.
        if (from === 'handlebars' && to === 'handlebars:handlebars3' && !require) {
            require = 'jenkins-handlebars-rt/runtimes/handlebars3_rt';
        }
        
        bundle.moduleMappings.push({
            from: from, 
            to: to, 
            require: require
        });
        
        return bundle;
    };            
    bundle.less = function(src, targetDir) {
        bundle.lessSrcPath = src;
        if (targetDir) {
            bundle.lessTargetDir = targetDir;
        }
        return bundle;
    };
    bundle.export = function(bundleId) {
        if (bundleId) {
            bundle.bundleExport = true;
            bundle.bundleExportPlugin = bundleId;
        } else if (isMavenBuild) {
            var xmlParser = require('xml2js').parseString;
            var pomXML = fs.readFileSync('pom.xml', "utf-8");

            bundle.bundleExport = true;
            xmlParser(pomXML, function (err, pom) {
                if (pom.project.packaging[0] === 'hpi') {
                    // It's a jenkins plugin (hpi), so capture the name of the plugin.
                    // This will be used later for the export namespace.
                    bundle.bundleExportPlugin = pom.project.artifactId[0];
                }
            });
        } else {
            gutil.log(gutil.colors.red("Error: This is not a maven project. You must define a 'bundleId' argument to the 'export' call."));
        }
    }
    
    bundles.push(bundle);
    
    return bundle;
};

exports.logInfo = function(message) {
    gutil.log(gutil.colors.green(message));
}
exports.logWarn = function(message) {
    gutil.log(gutil.colors.orange(message));
}
exports.logError = function(message) {
    gutil.log(gutil.colors.red(message));
}

var tasks = {
    test: function () {
        if (!testSrcPath) {
            exports.logWarn("Warn: Test src path has been unset. No tests to run.");
            return;
        }
        
        var terminalReporter = new jasmineReporters.TerminalReporter({
            verbosity: 3,
            color: true,
            showStack: true
        });        
        var junitReporter = new jasmineReporters.JUnitXmlReporter({
            savePath: 'target/surefire-reports',
            consolidateAll: true,
            filePrefix: 'JasmineReport'    
        });

        var testSpecs = testSrcPath + '/**/*-spec.js';
        
        global.jenkinsBuilder = exports;
        _startTestWebServer();
        gulp.src(testSpecs)
            .pipe(jasmine({reporter: [terminalReporter, junitReporter, {
                jasmineDone: function () {
                    gulp.emit('testing_completed');
                }                
            }]}));
    },
    bundle: function() {
        if (bundles.length === 0) {
            exports.logError("Error: Cannot perform 'bundle' task. No 'module' bundles are registered. You must call require('jenkins-js-build').bundle([module]) in gulpfile.js, specifying at least one bundle 'module'.");
            throw "'bundle' task failed. See error above.";
        }
        
        // Bundle all bundles.
        for (var i = 0; i < bundles.length; i++) {
            var bundle = bundles[i];
            
            if (!bundle.bundleToAdjunctPackageDir && !bundle.bundleAsJenkinsModule && !bundle.bundleInDir) {
                exports.logError("Error: Cannot perform 'bundle' task. No bundle output spec defined. You must call 'inAdjunctPackage([adjunct-package-name])' or 'asJenkinsModuleResource' or 'inDir([dir])' on the response return from the call to 'bundle'.");
                throw "'bundle' task failed. See error above.";
            }
    
            var bundleTo;
            if (bundle.bundleAsJenkinsModule) {
                bundleTo = jsmodulesBasePath;
            } else if (bundle.bundleInDir) {
                bundleTo = bundle.bundleInDir;
            } else {
                bundleTo = adjunctBasePath + "/" + bundle.bundleToAdjunctPackageDir;
            }
    
            if (bundle.lessSrcPath) {
                var lessBundleTo = bundleTo;
                
                if (bundle.bundleAsJenkinsModule) {
                    // If it's a jenkins module, the CSS etc need to go into a folder under jsmodulesBasePath
                    // and the name of the folder must be the module name
                    lessBundleTo += '/' + bundle.as;
                } else if (bundle.lessTargetDir) {
                    lessBundleTo = bundle.lessTargetDir;
                }
                
                less(bundle.lessSrcPath, lessBundleTo);
            }
            
            var fileToBundle = bundle.bundleModule;
            if (bundle.bundleDependencyModule) {
                // Lets generate a temp file containing the module require.
                if (!fs.existsSync('target')) {
                    fs.mkdirSync('target');
                }
                fileToBundle = 'target/' + bundle.bundleOutputFile;
                fs.writeFileSync(fileToBundle, "module.exports = require('" + bundle.module + "');");
            }
            
            var bundler = browserify({
                entries: [fileToBundle],
                extensions: ['.js', '.hbs'],
                cache: {},
                packageCache: {},
                fullPaths: false
            });
            var hbsfy = require("hbsfy").configure({
                compiler: "require('jenkins-handlebars-rt/runtimes/handlebars3_rt')"
            });
            bundler.transform(hbsfy);        
            if (bundle.bundleTransforms) {
                for (var i = 0; i < bundle.bundleTransforms.length; i++) {
                    bundler.transform(bundle.bundleTransforms[i]);        
                }
            }
            addModuleMappingTransforms(bundle, bundler);
            
            bundler.bundle().pipe(source(bundle.bundleOutputFile))
                .pipe(gulp.dest(bundleTo));            
        }
    },
    rebundle: function() {
        var watchList = [];

        watchList.push('./index.js');
        for (var i = 0; i < srcPaths.length; i++) {
            var srcPath = srcPaths[i];
            watchList.push(srcPath + '/**/*.*');
        }
        exports.logInfo('rebundle watch list: ' + watchList);
        
        gulp.watch(watchList, ['bundle']);
    },
    jshint: function() {
        var jshint = require('gulp-jshint');
        var hasJsHintConfig = fs.existsSync(cwd + '/.jshintrc');
        var jshintConfig;
        
        if (!hasJsHintConfig) {
            exports.logInfo('\t- Using default JSHint configuration (in jenkins-js-builder). Override by defining a .jshintrc in this folder.');
            jshintConfig = require('./res/default.jshintrc');
        }        
        function runJsHint(pathSet) {
            for (var i = 0; i < pathSet.length; i++) {
                gulp.src(pathSet[i] + '/**/*.js')
                    .pipe(jshint(jshintConfig))
                    .pipe(jshint.reporter('default'))
                    .pipe(jshint.reporter('fail'));
            }
        }
        runJsHint(srcPaths);
        runJsHint([testSrcPath]);        
    }
};

function addModuleMappingTransforms(bundle, bundler) {
    var moduleMappings = bundle.moduleMappings;

    if (moduleMappings.length > 0) {
        var requireTransform = transformTools.makeRequireTransform("requireTransform",
            {evaluateArguments: true},
            function(args, opts, cb) {
                var required = args[0];
                for (var i = 0; i < moduleMappings.length; i++) {
                    var mapping = moduleMappings[i];
                    if (mapping.from === required) {
                        if (mapping.require) {
                            return cb(null, "require('" + mapping.require + "')");
                        } else {
                            return cb(null, "require('jenkins-js-modules').require('" + mapping.to + "')");
                        }
                    }
                }
                return cb();
            });
        bundler.transform(requireTransform);
    }
    var importExportApplied = false;
    var importExportTransform = transformTools.makeStringTransform("importExportTransform", {},
        function (content, opts, done) {
            if (!importExportApplied) {
                try {
                    var imports = "";
                    for (var i = 0; i < moduleMappings.length; i++) {
                        var mapping = moduleMappings[i];
                        if (imports.length > 0) {
                            imports += ", ";
                        }
                        imports += "'" + mapping.to + "'";
                    }
    
                    var exportNamespace = 'undefined'; // global namespace
                    var exportModule = '{}'; // exporting nothing (an "empty" module object)
    
                    if (bundle.bundleExportPlugin) {
                        // It's a hpi plugin, so use it's name as the export namespace.
                        exportNamespace = "'" + bundle.bundleExportPlugin + "'";
                    }
                    if (bundle.bundleExport) {
                        // export function was called, so export the module.
                        exportModule = 'module'; // export the module
                    }
    
                    // Always call export, even if the export function was not called on the builder instance.
                    // If the export function was not called, we export nothing (see above). In this case, it just 
                    // generates an event for any modules that need to sync on the load event for the module.
                    content += "\n" +
                        "\t\trequire('jenkins-js-modules').export(" + exportNamespace + ", '" + bundle.as + "', " + exportModule + ");";
    
                    if (bundle.bundleExportPlugin && bundle.lessSrcPath) {
                        content += "\n" +
                            "\t\trequire('jenkins-js-modules').addModuleCSSToPage('" + bundle.bundleExportPlugin + "', '" + bundle.as + "');";
                    }
    
                    if (imports.length > 0) {
                        var wrappedContent =
                            "require('jenkins-js-modules')\n" +
                                "    .import(" + imports + ")\n" +
                                "    .onFulfilled(function() {\n" +
                                "\n" +
                                content +
                                "\n" +
                                "    });\n";
    
                        return done(null, wrappedContent);
                    } else {
                        return done(null, content);
                    }
                } finally {
                    importExportApplied = true;                    
                }
            } else {
                return done(null, content);
            }
        });    

    bundler.transform(importExportTransform);
}

function less(src, targetDir) {
    var less = require('gulp-less');
    gulp.src(src)
        .pipe(less())
        .pipe(gulp.dest(targetDir));
}

function _startTestWebServer(config) {
    if (!config) {
        config = {}
    }
    if (!config.port) {
        config.port = 18999;
    }
    if (!config.root) {
        config.root = cwd;
    }
    
    if (!testWebServer) {
        // Start a web server that will allow tests to request resources.
        testWebServer = require('node-http-server').deploy(config);
        exports.logInfo('Testing web server started on port ' + config.port + ' (http://localhost:' + config.port + '). Content root: ' + config.root);
    }
}
gulp.on('testing_completed', function(x) {
    if (testWebServer) {
        testWebServer.close();
        testWebServer = undefined;
        exports.logInfo('Testing web server stopped.');
    }
});

function _stopTestWebServer() {
    if (testWebServer) {
        testWebServer.close();
        testWebServer = undefined;
        exports.logInfo('Testing web server stopped.');
    }
}

// Defined default tasks. Can be overridden.
exports.defineTasks(['jshint', 'test', 'bundle', 'rebundle']);