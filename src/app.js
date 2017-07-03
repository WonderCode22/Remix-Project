/* global alert, confirm, prompt, Option, Worker, chrome */
'use strict'

var async = require('async')
var $ = require('jquery')
var base64 = require('js-base64').Base64
var swarmgw = require('swarmgw')
var csjs = require('csjs-inject')

var QueryParams = require('./app/query-params')
var queryParams = new QueryParams()

var Remixd = require('./lib/remixd')
var Storage = require('./app/files/storage')
var Browserfiles = require('./app/files/browser-files')
var Config = require('./app/config')
var Editor = require('./app/editor')
var Renderer = require('./app/renderer')
var Compiler = require('./app/compiler')
var ExecutionContext = require('./app/execution-context')
var UniversalDApp = require('./universal-dapp.js')
var EventManager = require('ethereum-remix').lib.EventManager
var OffsetToLineColumnConverter = require('./lib/offsetToLineColumnConverter')
var RighthandPanel = require('./app/righthand-panel')
var examples = require('./app/example-contracts')

// The event listener needs to be registered as early as possible, because the
// parent will send the message upon the "load" event.
var filesToLoad = null
var loadFilesCallback = function (files) { filesToLoad = files } // will be replaced later

window.addEventListener('message', function (ev) {
  if (typeof ev.data === typeof [] && ev.data[0] === 'loadFiles') {
    loadFilesCallback(ev.data[1])
  }
}, false)
var run = function () {
  var self = this
  this.event = new EventManager()
  var fileStorage = new Storage('sol:')
  var config = new Config(fileStorage)
  var remixd = new Remixd()
  var filesProviders = {}
  filesProviders['browser'] = new Browserfiles(fileStorage)

  var tabbedFiles = {} // list of files displayed in the tabs bar

  // return all the files, except the temporary/readonly ones.. package only files from the browser storage.

  function createNonClashingName (path) {
    var counter = ''
    if (path.endsWith('.sol')) path = path.substring(0, path.lastIndexOf('.sol'))
    while (filesProviders['browser'].exists(path + counter + '.sol')) {
      counter = (counter | 0) + 1
    }
    return path + counter + '.sol'
  }

  // Add files received from remote instance (i.e. another browser-solidity)
  function loadFiles (filesSet) {
    for (var f in filesSet) {
      filesProviders['browser'].set(createNonClashingName(f), filesSet[f].content)
    }
    switchToNextFile()
  }
  // Replace early callback with instant response
  loadFilesCallback = function (files) {
    loadFiles(files)
  }
  // Run if we did receive an event from remote instance while starting up
  if (filesToLoad !== null) {
    loadFiles(filesToLoad)
  }

  filesProviders['browser'].set(examples.ballot.name, examples.ballot.content)

  // ----------------- editor ----------------------
  var editor = new Editor(document.getElementById('input'))


  var FILE_SCROLL_DELTA = 300


  function switchToFile (file) {
    editorSyncFile()
    config.set('currentFile', file)
    //refreshTabs(file)
    fileProviderOf(file).get(file, (error, content) => {
      if (error) {
        console.log(error)
      } else {
        if (fileProviderOf(file).isReadOnly(file)) {
          editor.openReadOnly(file, content)
        } else {
          editor.open(file, content)
        }
        self.event.trigger('currentFileChanged', [file, fileProviderOf(file)])
      }
    })
  }

  function switchToNextFile () {
    var fileList = Object.keys(filesProviders['browser'].list())
    if (fileList.length) {
      switchToFile(fileList[0])
    }
  }

  var previouslyOpenedFile = config.get('currentFile')
  if (previouslyOpenedFile) {
    filesProviders['browser'].get(previouslyOpenedFile, (error, content) => {
      if (!error && content) {
        switchToFile(previouslyOpenedFile)
      } else {
        switchToNextFile()
      }
    })
  } else {
    switchToNextFile()
  }

  function fileProviderOf (file) {
    var provider = file.match(/[^/]*/)
    if (provider !== null) {
      return filesProviders[provider[0]]
    }
    return null
  }


  var compiler = new Compiler(handleImportCall)
  var offsetToLineColumnConverter = new OffsetToLineColumnConverter(compiler.event)

  // ----------------- Renderer -----------------
  var transactionContextAPI = {
    getAddress: (cb) => {
      cb(null, $('#txorigin').val())
    },
    getValue: (cb) => {
      try {
        var comp = $('#value').val().split(' ')
        cb(null, executionContext.web3().toWei(comp[0], comp.slice(1).join(' ')))
      } catch (e) {
        cb(e)
      }
    },
    getGasLimit: (cb) => {
      cb(null, $('#gasLimit').val())
    }
  }

  var rendererAPI = {
    error: (file, error) => {
      if (file === config.get('currentFile')) {
        editor.addAnnotation(error)
      }
    },
    errorClick: (errFile, errLine, errCol) => {
      if (errFile !== config.get('currentFile') && filesProviders['browser'].exists(errFile)) {
        switchToFile(errFile)
      }
      editor.gotoLine(errLine, errCol)
    },
    currentCompiledSourceCode: () => {
      if (compiler.lastCompilationResult.source) {
        return compiler.lastCompilationResult.source.sources[compiler.lastCompilationResult.source.target]
      }
      return ''
    },
    resetDapp: (udappContracts, renderOutputModifier) => {
      udapp.reset(udappContracts, transactionContextAPI, renderOutputModifier)
    },
    renderDapp: () => {
      return udapp.render()
    },
    getAccounts: (callback) => {
      udapp.getAccounts(callback)
    },
    getBalance: (address, callback) => {
      udapp.getBalance(address, (error, balance) => {
        if (error) {
          callback(error)
        } else {
          callback(null, executionContext.web3().fromWei(balance, 'ether'))
        }
      })
    }
  }
  var renderer = new Renderer(rendererAPI, compiler.event)

  // ------------------------------------------------------------
  var executionContext = new ExecutionContext()

  // ----------------- UniversalDApp -----------------
  var udapp = new UniversalDApp(executionContext, {
    removable: false,
    removable_instances: true
  })

  function swarmVerifiedPublish (content, expectedHash, cb) {
    swarmgw.put(content, function (err, ret) {
      if (err) {
        cb(err)
      } else if (ret !== expectedHash) {
        cb('Hash mismatch')
      } else {
        cb()
      }
    })
  }

  function publishOnSwarm (contract, cb) {
    // gather list of files to publish
    var sources = []

    sources.push({
      content: contract.metadata,
      hash: contract.metadataHash
    })

    var metadata
    try {
      metadata = JSON.parse(contract.metadata)
    } catch (e) {
      return cb(e)
    }

    if (metadata === undefined) {
      return cb('No metadata')
    }

    async.eachSeries(Object.keys(metadata.sources), function (fileName, cb) {
      // find hash
      var hash
      try {
        hash = metadata.sources[fileName].urls[0].match('bzzr://(.+)')[1]
      } catch (e) {
        return cb('Metadata inconsistency')
      }

      fileProviderOf(fileName).get(fileName, (error, content) => {
        if (error) {
          console.log(error)
        } else {
          sources.push({
            content: content,
            hash: hash
          })
        }
        cb()
      })
    }, function () {
      // publish the list of sources in order, fail if any failed
      async.eachSeries(sources, function (item, cb) {
        swarmVerifiedPublish(item.content, item.hash, cb)
      }, cb)
    })
  }

  udapp.event.register('publishContract', this, function (contract) {
    publishOnSwarm(contract, function (err) {
      if (err) {
        alert('Failed to publish metadata: ' + err)
      } else {
        alert('Metadata published successfully')
      }
    })
  })

  // ---------------- Righthand-panel --------------------
  var rhpAPI = {
    config: config,
    onResize: onResize,
    warnCompilerLoading: (msg) => {
      renderer.clear()
      if (msg) {
        renderer.error(msg, $('#output'), {type: 'warning'})
      }
    },
    executionContextChange: (context) => {
      return executionContext.executionContextChange(context)
    },
    executionContextProvider: () => {
      return executionContext.getProvider()
    }
  }
  var rhpEvents = {
    compiler: compiler.event,
    app: self.event,
    udapp: udapp.event
  }
  var righthandPanel = new RighthandPanel(document.body, rhpAPI, rhpEvents, {}) // eslint-disable-line
  // ----------------- editor resize ---------------

  function onResize () {
    editor.resize(false)
  }
  window.onresize = onResize
  onResize()

  document.querySelector('#editor').addEventListener('change', onResize)

  // ----------------- compiler ----------------------

  function handleGithubCall (root, path, cb) {
    return $.getJSON('https://api.github.com/repos/' + root + '/contents/' + path)
      .done(function (data) {
        if ('content' in data) {
          cb(null, base64.decode(data.content))
        } else {
          cb('Content not received')
        }
      })
      .fail(function (xhr, text, err) {
        // NOTE: on some browsers, err equals to '' for certain errors (such as offline browser)
        cb(err || 'Unknown transport error')
      })
  }

  function handleSwarmImport (url, cb) {
    swarmgw.get(url, function (err, content) {
      // retry if this failed and we're connected via RPC
      if (err && !executionContext.isVM()) {
        var web3 = executionContext.web3()
        web3.swarm.download(url, cb)
      } else {
        cb(err, content)
      }
    })
  }

  function handleIPFS (url, cb) {
    // replace ipfs:// with /ipfs/
    url = url.replace(/^ipfs:\/\/?/, 'ipfs/')

    return $.ajax({ type: 'GET', url: 'https://gateway.ipfs.io/' + url })
      .done(function (data) {
        cb(null, data)
      })
      .fail(function (xhr, text, err) {
        // NOTE: on some browsers, err equals to '' for certain errors (such as offline browser)
        cb(err || 'Unknown transport error')
      })
  }

  function handleImportCall (url, cb) {
    var provider = fileProviderOf(url)
    if (provider && provider.exists(url)) {
      return provider.get(url, cb)
    }

    var handlers = [
      { match: /^(https?:\/\/)?(www.)?github.com\/([^/]*\/[^/]*)\/(.*)/, handler: function (match, cb) { handleGithubCall(match[3], match[4], cb) } },
      { match: /^(bzz[ri]?:\/\/?.*)$/, handler: function (match, cb) { handleSwarmImport(match[1], cb) } },
      { match: /^(ipfs:\/\/?.+)/, handler: function (match, cb) { handleIPFS(match[1], cb) } }
    ]

    var found = false
    handlers.forEach(function (handler) {
      if (found) {
        return
      }

      var match = handler.match.exec(url)
      if (match) {
        found = true

        $('#output').append($('<div/>').append($('<pre/>').text('Loading ' + url + ' ...')))
        handler.handler(match, function (err, content) {
          if (err) {
            cb('Unable to import "' + url + '": ' + err)
            return
          }

          // FIXME: at some point we should invalidate the cache
          filesProviders['browser'].addReadOnly(url, content)
          cb(null, content)
        })
      }
    })

    if (found) {
      return
    } else if (/^[^:]*:\/\//.exec(url)) {
      cb('Unable to import "' + url + '": Unsupported URL schema')
    } else {
      cb('Unable to import "' + url + '": File not found')
    }
  }


  // ----------------- autoCompile -----------------
  var autoCompile = true//document.querySelector('#autoCompile').checked
  if (config.exists('autoCompile')) {
    autoCompile = config.get('autoCompile')
  }

  function runCompiler () {

    editorSyncFile()
    var currentFile = config.get('currentFile')
    if (currentFile) {
      var target = currentFile
      var sources = {}
      var provider = fileProviderOf(currentFile)
      if (provider) {
        provider.get(target, (error, content) => {
          if (error) {
            console.log(error)
          } else {
            sources[target] = content
            compiler.compile(sources, target)
          }
        })
      } else {
        console.log('cannot compile ' + currentFile + '. Does not belong to any explorer')
      }
    }
  }

  function editorSyncFile () {
    var currentFile = config.get('currentFile')
    if (currentFile && editor.current()) {
      var input = editor.get(currentFile)
      var provider = fileProviderOf(currentFile)
      if (provider) {
        provider.set(currentFile, input)
      } else {
        console.log('cannot save ' + currentFile + '. Does not belong to any explorer')
      }
    }
  }

  var previousInput = ''
  var compileTimeout = null
  var saveTimeout = null

  function editorOnChange () {
    var currentFile = config.get('currentFile')
    if (!currentFile) {
      return
    }
    var input = editor.get(currentFile)

    // if there's no change, don't do anything
    if (input === previousInput) {
      return
    }
    previousInput = input

    // fire storage update
    // NOTE: save at most once per 5 seconds
    if (saveTimeout) {
      window.clearTimeout(saveTimeout)
    }
    saveTimeout = window.setTimeout(editorSyncFile, 5000)

    // special case: there's nothing else to do
    if (input === '') {
      return
    }

    if (!autoCompile) {
      return
    }

    if (compileTimeout) {
      window.clearTimeout(compileTimeout)
    }
    compileTimeout = window.setTimeout(runCompiler, 300)
  }

  editor.event.register('contentChanged', editorOnChange)
  // in order to save the file when switching
  editor.event.register('sessionSwitched', editorOnChange)

  executionContext.event.register('contextChanged', this, function (context) {
    runCompiler()
  })

  executionContext.event.register('web3EndpointChanged', this, function (context) {
    runCompiler()
  })

  compiler.event.register('compilerLoaded', this, function (version) {
    previousInput = ''
    runCompiler()

    if (queryParams.get().context) {
      executionContext.setContext(queryParams.get().context, queryParams.get().endpointurl)
    }
  })

  compiler.event.register('compilationStarted', this, function () {
    editor.clearAnnotations()
  })

  function loadVersion (version) {
    queryParams.update({ version: version })
    var url
    if (version === 'builtin') {
      var location = window.document.location
      location = location.protocol + '//' + location.host + '/' + location.pathname
      if (location.endsWith('index.html')) {
        location = location.substring(0, location.length - 10)
      }
      if (!location.endsWith('/')) {
        location += '/'
      }

      url = location + 'soljson.js'
    } else {
      url = 'https://ethereum.github.io/solc-bin/bin/' + version
    }
    var isFirefox = typeof InstallTrigger !== 'undefined'
    if (document.location.protocol !== 'file:' && Worker !== undefined && isFirefox) {
      // Workers cannot load js on "file:"-URLs and we get a
      // "Uncaught RangeError: Maximum call stack size exceeded" error on Chromium,
      // resort to non-worker version in that case.
      compiler.loadVersion(true, url)
    } else {
      compiler.loadVersion(false, url)
    }
  }

  compiler.setOptimize(false)
  loadVersion("soljson-v0.4.11+commit.68ef5810.js")
}

module.exports = {
  'run': run
}
