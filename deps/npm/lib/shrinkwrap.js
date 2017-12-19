'use strict'

const BB = require('bluebird')

const chain = require('slide').chain
const detectIndent = require('detect-indent')
const readFile = BB.promisify(require('graceful-fs').readFile)
const getRequested = require('./install/get-requested.js')
const id = require('./install/deps.js')
const iferr = require('iferr')
const isOnlyOptional = require('./install/is-only-optional.js')
const isOnlyDev = require('./install/is-only-dev.js')
const lifecycle = require('./utils/lifecycle.js')
const log = require('npmlog')
const moduleName = require('./utils/module-name.js')
const move = require('move-concurrently')
const npm = require('./npm.js')
const path = require('path')
const readPackageTree = BB.promisify(require('read-package-tree'))
const ssri = require('ssri')
const validate = require('aproba')
const writeFileAtomic = require('write-file-atomic')
const unixFormatPath = require('./utils/unix-format-path.js')
const isRegistry = require('./utils/is-registry.js')

const PKGLOCK = 'package-lock.json'
const SHRINKWRAP = 'npm-shrinkwrap.json'
const PKGLOCK_VERSION = npm.lockfileVersion

// emit JSON describing versions of all packages currently installed (for later
// use with shrinkwrap install)
shrinkwrap.usage = 'npm shrinkwrap'

module.exports = exports = shrinkwrap
function shrinkwrap (args, silent, cb) {
  if (typeof cb !== 'function') {
    cb = silent
    silent = false
  }

  if (args.length) {
    log.warn('shrinkwrap', "doesn't take positional args")
  }

  move(
    path.resolve(npm.prefix, PKGLOCK),
    path.resolve(npm.prefix, SHRINKWRAP),
    { Promise: BB }
  ).then(() => {
    log.notice('', `${PKGLOCK} has been renamed to ${SHRINKWRAP}. ${SHRINKWRAP} will be used for future installations.`)
    return readFile(path.resolve(npm.prefix, SHRINKWRAP)).then((d) => {
      return JSON.parse(d)
    })
  }, (err) => {
    if (err.code !== 'ENOENT') {
      throw err
    } else {
      return readPackageTree(npm.localPrefix).then(
        id.computeMetadata
      ).then((tree) => {
        return BB.fromNode((cb) => {
          createShrinkwrap(tree, {
            silent,
            defaultFile: SHRINKWRAP
          }, cb)
        })
      })
    }
  }).then((data) => cb(null, data), cb)
}

module.exports.createShrinkwrap = createShrinkwrap

function createShrinkwrap (tree, opts, cb) {
  opts = opts || {}
  lifecycle(tree.package, 'preshrinkwrap', tree.path, function () {
    const pkginfo = treeToShrinkwrap(tree)
    chain([
      [lifecycle, tree.package, 'shrinkwrap', tree.path],
      [shrinkwrap_, tree.path, pkginfo, opts],
      [lifecycle, tree.package, 'postshrinkwrap', tree.path]
    ], iferr(cb, function (data) {
      cb(null, pkginfo)
    }))
  })
}

function treeToShrinkwrap (tree) {
  validate('O', arguments)
  var pkginfo = {}
  if (tree.package.name) pkginfo.name = tree.package.name
  if (tree.package.version) pkginfo.version = tree.package.version
  if (tree.children.length) {
    pkginfo.requires = true
    shrinkwrapDeps(pkginfo.dependencies = {}, tree, tree)
  }
  if (tree.children.some(child => child.isAsset)) {
    pkginfo.requires = true
    shrinkwrapAssets(pkginfo.assets = {}, tree)
  }
  return pkginfo
}

function shrinkwrapAssets (assets, tree) {
  validate('OO', arguments)
  sortModules(tree.children.filter(child => child.isAsset)).forEach(function (asset) {
    if (asset.fakeChild) {
      assets[moduleName(asset)] = asset.fakeChild
      return
    }
    var pkginfo = assets[moduleName(asset)] = {}
    var requested = asset.package._requested || getRequested(asset) || {}
    pkginfo.version = childVersion(tree, asset, requested)
    if (isRegistry(requested)) {
      pkginfo.resolved = asset.package._resolved
    }
    // no integrity for git assets as integirty hashes are based on the
    // tarball and we can't (yet) create consistent tarballs from a stable
    // source.
    if (requested.type !== 'git') {
      if (asset.package._integrity) {
        pkginfo.integrity = asset.package._integrity
      } else if (asset.package._shasum) {
        pkginfo.integrity = ssri.fromHex(asset.package._shasum, 'sha1')
      }
    }
    if (asset.requires.length) {
      pkginfo.requires = {}
      sortModules(asset.requires).forEach((required) => {
        var requested = required.package._requested || getRequested(required) || {}
        pkginfo.requires[moduleName(required)] = childVersion(tree, required, requested)
      })
    }
  })
}

function shrinkwrapDeps (deps, top, tree, seen) {
  validate('OOO', [deps, top, tree])
  if (!seen) seen = new Set()
  if (seen.has(tree)) return
  seen.add(tree)
  sortModules(tree.children.filter(child => !child.isAsset)).forEach(function (child) {
    if (child.fakeChild) {
      deps[moduleName(child)] = child.fakeChild
      return
    }
    var childIsOnlyDev = isOnlyDev(child)
    var pkginfo = deps[moduleName(child)] = {}
    var requested = child.package._requested || getRequested(child) || {}
    pkginfo.version = childVersion(top, child, requested)
    if (child.fromBundle || child.isInLink) {
      pkginfo.bundled = true
    } else {
      if (isRegistry(requested)) {
        pkginfo.resolved = child.package._resolved
      }
      // no integrity for git deps as integirty hashes are based on the
      // tarball and we can't (yet) create consistent tarballs from a stable
      // source.
      if (requested.type !== 'git') {
        if (child.package._integrity) {
          pkginfo.integrity = child.package._integrity
        } else if (child.package._shasum) {
          pkginfo.integrity = ssri.fromHex(child.package._shasum, 'sha1')
        }
      }
    }
    if (childIsOnlyDev) pkginfo.dev = true
    if (isOnlyOptional(child)) pkginfo.optional = true
    if (child.requires.length) {
      pkginfo.requires = {}
      sortModules(child.requires).forEach((required) => {
        var requested = required.package._requested || getRequested(required) || {}
        pkginfo.requires[moduleName(required)] = childVersion(top, required, requested)
      })
    }
    if (child.children.length) {
      pkginfo.dependencies = {}
      shrinkwrapDeps(pkginfo.dependencies, top, child, seen)
    }
  })
}

function sortModules (modules) {
  // sort modules with the locale-agnostic Unicode sort
  var sortedModuleNames = modules.map(moduleName).sort()
  return modules.sort((a, b) => (
    sortedModuleNames.indexOf(moduleName(a)) - sortedModuleNames.indexOf(moduleName(b))
  ))
}

function childVersion (top, child, req) {
  if (req.type === 'directory' || req.type === 'file') {
    return 'file:' + unixFormatPath(path.relative(top.path, child.package._resolved || req.fetchSpec))
  } else if (!isRegistry(req) && !child.fromBundle) {
    return child.package._resolved || req.saveSpec || req.rawSpec
  } else {
    return child.package.version
  }
}

function shrinkwrap_ (dir, pkginfo, opts, cb) {
  save(dir, pkginfo, opts, cb)
}

function save (dir, pkginfo, opts, cb) {
  // copy the keys over in a well defined order
  // because javascript objects serialize arbitrarily
  BB.join(
    readPackageFile(dir, SHRINKWRAP),
    readPackageFile(dir, PKGLOCK),
    readPackageFile(dir, 'package.json'),
    (shrinkwrap, lockfile, pkg) => {
      const info = (
        shrinkwrap ||
        lockfile ||
        {
          path: path.resolve(dir, opts.defaultFile || PKGLOCK),
          data: '{}',
          indent: (pkg && pkg.indent) || 2
        }
      )
      const updated = updateLockfileMetadata(pkginfo, pkg && pkg.data)
      const swdata = JSON.stringify(updated, null, info.indent) + '\n'
      if (swdata === info.raw) {
        // skip writing if file is identical
        log.verbose('shrinkwrap', `skipping write for ${path.basename(info.path)} because there were no changes.`)
        cb(null, pkginfo)
      } else {
        writeFileAtomic(info.path, swdata, (err) => {
          if (err) return cb(err)
          if (opts.silent) return cb(null, pkginfo)
          if (!shrinkwrap && !lockfile) {
            log.notice('', `created a lockfile as ${path.basename(info.path)}. You should commit this file.`)
          }
          cb(null, pkginfo)
        })
      }
    }
  ).then((file) => {
  }, cb)
}

function updateLockfileMetadata (pkginfo, pkgJson) {
  // This is a lot of work just to make sure the extra metadata fields are
  // between version and dependencies fields, without affecting any other stuff
  const newPkg = {}
  let metainfoWritten = false
  const metainfo = new Set([
    'lockfileVersion',
    'preserveSymlinks'
  ])
  Object.keys(pkginfo).forEach((k) => {
    if (k === 'dependencies') {
      writeMetainfo(newPkg)
    }
    if (!metainfo.has(k)) {
      newPkg[k] = pkginfo[k]
    }
    if (k === 'version') {
      writeMetainfo(newPkg)
    }
  })
  if (!metainfoWritten) {
    writeMetainfo(newPkg)
  }
  function writeMetainfo (pkginfo) {
    pkginfo.lockfileVersion = PKGLOCK_VERSION
    if (process.env.NODE_PRESERVE_SYMLINKS) {
      pkginfo.preserveSymlinks = process.env.NODE_PRESERVE_SYMLINKS
    }
    metainfoWritten = true
  }
  return newPkg
}

function readPackageFile (dir, name) {
  const file = path.resolve(dir, name)
  return readFile(
    file, 'utf8'
  ).then((data) => {
    return {
      path: file,
      raw: data,
      data: JSON.parse(data),
      indent: detectIndent(data).indent || 2
    }
  }).catch({code: 'ENOENT'}, () => {})
}

