'use strict'

const vm = require('vm');

// this DNE yet! assumes that it is a constructor func
// that creates an object with `.module`
const ModuleNamespaceExoticObject = vm.ModuleNamespaceExoticObject;
const V8_ALLOWS_NAMESPACE_OBJ_CREATION = Boolean(
  ModuleNamespaceExoticObject
);

const LoaderResolve = Symbol('@@resolve');
const LoaderFetch = Symbol('@@fetch');
const LoaderTranslate = Symbol('@@translate');
const LoaderInstantiate = Symbol('@@instantiate');

const MODULE_STATUS_SYM = Symbol('[[ModuleStatus]]');

const LOADER_REGISTRY_SYM = Symbol('[[Registry]]');
const LOADER_REALM_SYM = Symbol('[[Realm]]'); // "Context" in V8 parlance

const MS_DEPENDENCIES_SYM = Symbol('[[Dependencies]]');
const MS_PIPELINE_SYM = Symbol('[[Pipeline]]');
const MS_METADATA_SYM = Symbol('[[Metadata]]');
const MS_LOADER_SYM = Symbol('[[Loader]]');
const MS_MODULE_SYM = Symbol('[[Module]]');
const MS_ERROR_SYM = Symbol('[[Error]]');
const MS_KEY_SYM = Symbol('[[Key]]');

// 3.
class Loader {
  // 3.1.1
  constructor (realm = null) {
    this[LOADER_REGISTRY_SYM] = new Registry();
    this[LOADER_REALM_SYM] = realm;
  }

  // 3.3.2
  import (name, referrer = null) {
    return Promise.resolve(Resolve(this, name, referrer)).then(key => {
      const entry = EnsureRegistered(this, key);
      return LoadModule(entry, 'instantiate').then(() => {
        return EnsureEvaluated(entry);
      });
    });
  }

  // 3.3.3
  resolve (name, referrer = null) {
    return Promise.resolve(Resolve(this, name, referrer));
  }

  // 3.3.4
  load (name, referrer = null, stage = 'instantiate') {
    try {
      stage = String(stage);
      if (!IsValidStageValue(stage)) {
        throw new RangeError(`
          expected stage to be one of "fetch",
          "translate", or "instantiate", got "${stage}".
        `.split('\n').map(xs => xs.trim()).join(' '));
      }

      return Promise.resolve(Resolve(this, name, referrer)).then(key => {
        const entry = EnsureRegistered(this, key);
        return LoadModule(entry, stage);
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // 3.3.5
  get registry () {
    return this[LOADER_REGISTRY_SYM];
  }

  // 3.3.6 - OMITTED(no toStringTag WKS available)

  // to be implemented by subclasses:
  [LoaderResolve] (name, referrer) {
    throw new Error('@@resolve not implemented in base class.')
  }

  [LoaderFetch] (entry, key) {
    throw new Error('@@fetch not implemented in base class.')
  }

  [LoaderTranslate] (entry, payload) {
    throw new Error('@@translate not implemented in base class.')
  }

  [LoaderInstantiate] (entry, source) {
    throw new Error('@@instantiate is not implemented in base class.')
  }
};

// 4.
class Registry extends Map {
  constructor () {
    super();
  }

  // NOTE: it looks like Registry is just forwarding Map methods,
  // to that end I'm just extending Map and calling it a day.
}

// 5.

// 5.1.1
function GetCurrentStage (entry) {
  return entry[MS_PIPELINE_SYM][0]
}

// 5.1.2
function IsValidStageValue (stage) {
  return (
    stage === 'fetch' ||
    stage === 'translate' ||
    stage === 'instantiate'
  );
}

// 5.1.3
function GetStage (entry, stage) {
  const stages = entry[MS_PIPELINE_SYM];
  for (var i = 0; i < stages.length; ++i) {
    if (stages[i].stage === stage) {
      return stages[i];
    }
  }
}

// 5.1.4
function LoadModule (entry, stage) {
  switch (stage) {
    case 'fetch':
      return Promise.resolve(RequestFetch(entry));
    case 'translate':
      return Promise.resolve(RequestTranslate(entry));
    case 'instantiate':
      return Promise.resolve(RequestInstantiate(entry));
    default:
      return Promise.reject(new RangeError(`bad stage "${stage}"`));
  }
}

// 5.1.5
function UpgradeToStage (entry, stage) {
  const pipeline = entry[MS_PIPELINE_SYM];

  // faking a call to GetStage
  const stageEntry = GetStage(entry, stage);

  // the spec notes that a more performant approach may be used here,
  // but I'm playing it safe & implementing the spec directly.
  while (pipeline[0] !== stageEntry) {
    pipeline.shift();
  }
}

// 5.2.1
class ModuleStatus {
  constructor (loader, key, ns = undefined) {
    // 5.2.1 steps 2-3
    if (!(loader instanceof Loader)) {
      throw new TypeError(`
        Expected loader to be instanceof Loader,
        got ${loader.constructor.name} instead
      `.split('\n').map(xs => xs.trim()).join(' '));
    }

    let pipeline = [];
    let module;
    let deps;

    if (ns === undefined) {
      // 5.2.1 steps 7a-e:
      module = undefined; // a
      deps = undefined; // b
      pipeline.push({
        stage: 'fetch',
        result: undefined
      }); // c
      pipeline.push({
        stage: 'translate',
        result: undefined
      }); // d
      pipeline.push({
        stage: 'instantiate',
        result: undefined
      }); // e
    } else if (V8_ALLOWS_NAMESPACE_OBJ_CREATION) {
      // 5.2.1 steps 8a-g:
      // not implementable until V8 provides a means of
      // creating namespace exotic objects
      if (!(ns instanceof ModuleNamespaceExoticObject)) {
        throw new TypeError(
          'expected instance of vm.ModuleNamespaceExoticObject'
        );
      }
      module = ns.module;
      deps = [];
      const result = Promise.resolve(ns);
      pipeline.push({
        stage: 'instantiate',
        result
      });
    } else {
      throw new Error('module namespace objects not supported yet');
    }

    this[MS_LOADER_SYM] = loader;
    this[MS_PIPELINE_SYM] = pipeline;
    this[MS_KEY_SYM] = key;
    this[MS_MODULE_SYM] = module;
    this[MS_METADATA_SYM] = undefined;
    this[MS_DEPENDENCIES_SYM] = deps;
    this[MS_ERROR_SYM] = false;
  }

  // 5.4.2
  get stage () {
    return GetCurrentStage(this).stage;
  }

  // 5.4.3
  get originalKey () {
    return this[MS_KEY_SYM];
  }

  // 5.4.4
  get module () {
    return this[MS_MODULE_SYM];
  }

  // 5.4.5
  get error () {
    return this[MS_ERROR_SYM];
  }

  // 5.4.6
  get dependencies () {
    return this[MS_DEPENDENCIES_SYM];
  }

  // 5.4.7
  load (stage = 'fetch') {
    try {
      stage = String(stage);
      if (!IsValidStageValue(stage)) {
        throw new RangeError(`
          expected stage to be one of "fetch",
          "translate", or "instantiate", got "${stage}".
        `.split('\n').map(xs => xs.trim()).join(' '));
      }

      return LoadModule(this, stage);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // 5.4.8
  result (stage) {
    try {
      stage = String(stage);
      if (!IsValidStageValue(stage)) {
        throw new RangeError(`
          expected stage to be one of "fetch",
          "translate", or "instantiate", got "${stage}".
        `.split('\n').map(xs => xs.trim()).join(' '));
      }

      const stageEntry = GetStage(this, stage);
      if (stageEntry === undefined) {
        return Promise.resolve();
      }

      return Promise.resolve(stageEntry.result);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // 5.4.9
  resolve (stage, result) {
    try {
      stage = String(stage);
      if (!IsValidStageValue(stage)) {
        throw new RangeError(`
          expected stage to be one of "fetch",
          "translate", or "instantiate", got "${stage}".
        `.split('\n').map(xs => xs.trim()).join(' '));
      }

      const stageEntry = GetStage(this, stage);
      if (stageEntry === undefined) {
        throw new TypeError(`"${stage}" has already been resolved`)
      }

      UpgradeToStage(this, stage);

      const p0 = Promise.resolve(result);
      const p1 = p0.then(value => {
        if (stage === 'instantiate') {
          return SatisfyInstance(this, value, undefined, undefined).then(inst => {
            this[MS_MODULE_SYM] = inst;
            return value;
          });
        } else {
          const stageEntry = GetStage(this, stage);
          if (stageEntry === undefined) {
            throw new TypeError(`"${stage}" has already been resolved (b.)`);
          }
        }
        return value;
      });

      // const pcatch =
      p1.catch(() => {
        this[MS_ERROR_SYM] = true;
      });

      if (stageEntry.result === undefined) {
        stageEntry.result = p1;
      }

      return p1;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // 5.4.10
  reject (stage, error) {
    try {
      stage = String(stage);
      if (!IsValidStageValue(stage)) {
        throw new RangeError(`
          expected stage to be one of "fetch",
          "translate", or "instantiate", got "${stage}".
        `.split('\n').map(xs => xs.trim()).join(' '));
      }

      const stageEntry = GetStage(this, stage);
      if (stageEntry === undefined) {
        throw new TypeError(`"${stage}" has already been resolved`)
      }

      UpgradeToStage(this, stage);

      const p0 = Promise.resolve(error);
      const p1 = p0.then(value => {
        const stageEntry = GetStage(this, stage);
        if (stageEntry === undefined) {
          throw new TypeError(`"${stage}" has already been resolved (b.)`);
        }
        throw value;
      });

      // const pCatch =
      p1.catch(() => {
        this[MS_ERROR_SYM] = true;
      });

      if (stageEntry.result === undefined) {
        stageEntry.result = p1;
      }

      return p1;
    } catch (err) {
      return Promise.reject(err);
    }
  }
}

// 6.     Loading Semantics
// 6.1    Auxiliary Operations

// 6.1.1
function EnsureRegistered (loader, key) {
  const registry = loader[LOADER_REGISTRY_SYM];

  // NOTE: slightly off script here. technically we fetch
  // then create, this checks then creates then fetches.
  if (!registry.has(key)) {
    registry.set(key, new ModuleStatus(loader, key));
  }

  return registry.get(key);
}

// 6.1.2
function Resolve (loader, name, referrer) {
  return loader[LoaderResolve](name, referrer);
}

// 6.1.3
function ExtractDependencies (entry, instance) {
  const deps = [];
  if (instance instanceof vm.Module) {
    for (const dep of instance.requests) {
      deps.push({
        name: dep,
        status: undefined
      });
    }
  }
  entry[MS_DEPENDENCIES_SYM] = deps;
}

// 6.1.4
function Instantiation (loader, optionalInstance, source) {
  if (optionalInstance === undefined) {
    return new vm.Module(source);
  }

  // NOTE: cannot perform 6.1.4 step 3, cannot create namespace
  // exotic objects.
  if (V8_ALLOWS_NAMESPACE_OBJ_CREATION) {
    if (optionalInstance instanceof ModuleNamespaceExoticObject) {
      return optionalInstance.module;
    }
  }

  // NOTE: this is not part of the spec! this is here so that we can make the
  // thing work.
  if (optionalInstance instanceof vm.Module) {
    return optionalInstance;
  }

  // resuming 6.1.4 at step 4.
  if (typeof optionalInstance !== 'function') {
    throw new TypeError(
      'optionalInstance must be undefined, callable, or a namespace object'
    );
  }

  return optionalInstance;
}

// 6.2    Loading Operations

// 6.2.1
function RequestFetch (entry) {
  const fetchStageEntry = GetStage(entry, 'fetch');
  if (fetchStageEntry === undefined) {
    return Promise.resolve();
  }

  if (fetchStageEntry.result) {
    return fetchStageEntry.result;
  }

  const hook = entry[MS_LOADER_SYM][LoaderFetch];
  const hookResult = hook(entry, entry[MS_KEY_SYM]);

  const p = hookResult.then(payload => {
    UpgradeToStage(entry, 'translate');
    return payload;
  });

  // const pCatch =
  p.catch(() => {
    entry[MS_ERROR_SYM] = true;
  });

  fetchStageEntry.result = p;
  return p;
}

// 6.2.2
function RequestTranslate (entry) {
  const translateStageEntry = GetStage(entry, 'translate');
  if (translateStageEntry === undefined) {
    return Promise.resolve();
  }

  if (translateStageEntry.result) {
    return translateStageEntry.result;
  }

  const p = RequestFetch(entry).then(payload => {
    const hook = entry[MS_LOADER_SYM][LoaderTranslate];
    const hookResult = hook(entry, payload);
    return hookResult.then(source => {
      UpgradeToStage(entry, 'instantiate');
      return source;
    });
  });

  // const pCatch =
  p.catch(() => {
    entry[MS_ERROR_SYM] = true;
  });

  translateStageEntry.result = p;
  return p;
}

// 6.2.3
function RequestInstantiate (entry, instantiateSet) {
  const instantiateStageEntry = GetStage(entry, 'instantiate');
  if (instantiateStageEntry === undefined) {
    return Promise.resolve();
  }

  if (instantiateStageEntry.result) {
    return instantiateStageEntry.result;
  }

  const p = RequestTranslate(entry).then(source => {
    const hook = entry[MS_LOADER_SYM][LoaderInstantiate];
    const hookResult = hook(entry, source);
    return hookResult.then(optionalInstance => {
      return SatisfyInstance(
        entry,
        optionalInstance,
        source,
        instantiateSet
      ).then(instance => {
        entry[MS_MODULE_SYM] = instance;
        return optionalInstance; // NOTE: Really? not "instance"?
      });
    });
  });

  // const pCatch =
  p.catch(() => {
    entry[MS_ERROR_SYM] = true;
  });

  instantiateStageEntry.result = p;
  return p;
}

// 6.2.4
function SatisfyInstance (entry, optionalInstance, source, instantiateSet) {
  instantiateSet = instantiateSet || new Set();
  if (instantiateSet.has(entry)) {
    return;
  }
  instantiateSet.add(entry);

  const loader = entry[MS_LOADER_SYM];
  const instance = Instantiation(loader, optionalInstance, source);

  if (instance instanceof vm.Module) {
    module[MODULE_STATUS_SYM] = entry;
  }

  ExtractDependencies(entry, instance);

  const list = entry[MS_DEPENDENCIES_SYM].map(pair => {
    return Resolve(loader, pair.name, entry[MS_KEY_SYM]).then(depKey => {
      const depEntry = EnsureRegistered(loader, depKey);
      if (instantiateSet.has(depEntry)) {
        return;
      }
      pair.status = depEntry;
      return RequestInstantiate(depEntry, instantiateSet);
    });
  });

  return Promise.all(list).then(() => {
    return instance;
  });
}

// 7      Linking semantics
// 7.1    Resolving Dependencies -- NOTE except not really because we do that
//                                  ahead of time, yuk-yuk-yuk
// 7.1.1
// NOTE: to be passed to vm.Module#instantiate()
// NOTE: we're eliding the assertions here.
function HostResolveImportedModule (module, req) {
  const entry = module[MODULE_STATUS_SYM];
  const depEntry = entry[MS_DEPENDENCIES_SYM].get(req).status;
  return depEntry[MS_MODULE_SYM];
}

// 7.2    Linking

// 7.2.1
function DependencyGraph (root) {
  const result = new Set();
  ComputeDependencyGraph(root, result);

  // NOTE: this assumes sets are implicitly ordered
  // by item addition. result should be a list visited
  // in reverse-depth-first order
  return Array.from(result).reverse();
}

// 7.2.2
function ComputeDependencyGraph (entry, result) {
  if (result.has(entry)) {
    return;
  }

  result.add(entry);
  entry[MS_DEPENDENCIES_SYM].forEach(
    pair => ComputeDependencyGraph(pair.status, result)
  );
}

// 7.2.3
function EnsureLinked (entry) {
  const deps = DependencyGraph(entry);
  if (V8_ALLOWS_NAMESPACE_OBJ_CREATION) {
    deps.forEach(dep => {
      if (typeof dep[MS_MODULE_SYM] === 'function') {
        const func = dep[MS_MODULE_SYM];
        const ns = func();
        if (!(ns instanceof ModuleNamespaceExoticObject)) {
          throw new TypeError(
            'expected instanceof vm.ModuleNamespaceExoticObject'
          );
        }
        dep[MS_MODULE_SYM] = ns.module;
      }
    });
  }

  deps.forEach(dep => {
    const module = dep.module;
    module.instantiate(HostResolveImportedModule);
  });
}

// 7.2.4
function EnsureEvaluated (entry) {
  const module = entry.module;
  if (!module.evaluated) {
    EnsureLinked(entry);
    module.evaluate();
  }
  return module.namespace;
}

module.exports = Object.assign(Loader, {
  ResolveHook: LoaderResolve,
  FetchHook: LoaderFetch,
  TranslateHook: LoaderTranslate,
  InstantiateHook: LoaderInstantiate
});
