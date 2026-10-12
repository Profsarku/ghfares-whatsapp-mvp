/**
 * A small state graph runtime.
 *
 *   State  — one object that every node reads and writes. It flows along the edges.
 *   Nodes  — units of work. A node takes the state, does something, and may
 *            return a patch that is merged into the state.
 *   Edges  — the routing. A fixed edge always goes to the same node. A
 *            conditional edge reads the state and names the next node.
 *
 * The graph is checked when it is compiled (every edge points at a real node,
 * every node is reachable), and every run leaves a trace of the nodes it
 * visited. describe() and toMermaid() print the structure.
 */

const START = '__start__';
const END = '__end__';

class GraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GraphError';
  }
}

/** A unit of work. Subclasses override run(). */
class Node {
  /**
   * @param {string} name
   * @param {{ description?: string }} [opts]
   */
  constructor(name, opts = {}) {
    if (!name) throw new GraphError('a node needs a name');
    this.name = name;
    this.description = opts.description || '';
  }

  /**
   * @param {object} state
   * @returns {Promise<object|void>|object|void} a patch merged into the state, or nothing
   */
  // eslint-disable-next-line no-unused-vars
  async run(state) {
    throw new GraphError(`node ${this.name} does not implement run()`);
  }
}

/** Wraps a plain function as a node. */
class FunctionNode extends Node {
  constructor(name, fn, opts) {
    super(name, opts);
    if (typeof fn !== 'function') throw new GraphError(`node ${name} needs a function`);
    this.fn = fn;
  }

  run(state) {
    return this.fn(state);
  }
}

class Edge {
  constructor(from, to) {
    this.from = from;
    this.to = to;
  }

  next() {
    return this.to;
  }

  targets() {
    return [this.to];
  }
}

class ConditionalEdge {
  /**
   * @param {string} from
   * @param {(state: object) => string} router returns a key of paths (or a node name when paths is omitted)
   * @param {Record<string, string>|string[]} [paths] key → node, or the list of nodes the router may name
   */
  constructor(from, router, paths) {
    this.from = from;
    this.router = router;
    this.paths = Array.isArray(paths)
      ? Object.fromEntries(paths.map(name => [name, name]))
      : (paths || null);
  }

  next(state) {
    const key = this.router(state);
    if (!this.paths) return key;
    if (!Object.prototype.hasOwnProperty.call(this.paths, key)) {
      throw new GraphError(`router after ${this.from} returned "${key}", which is not one of: ${Object.keys(this.paths).join(', ')}`);
    }
    return this.paths[key];
  }

  targets() {
    return this.paths ? [...new Set(Object.values(this.paths))] : [];
  }
}

class StateGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
  }

  /**
   * @param {string|Node} nameOrNode
   * @param {Function|Node} [impl]
   */
  addNode(nameOrNode, impl, opts) {
    let node;
    if (nameOrNode instanceof Node) node = nameOrNode;
    else if (impl instanceof Node) node = impl;
    else node = new FunctionNode(nameOrNode, impl, opts);
    if (typeof nameOrNode === 'string' && node.name !== nameOrNode) node.name = nameOrNode;
    if (node.name === START || node.name === END) throw new GraphError(`${node.name} is reserved`);
    if (this.nodes.has(node.name)) throw new GraphError(`node ${node.name} is already in the graph`);
    this.nodes.set(node.name, node);
    return this;
  }

  addEdge(from, to) {
    this.#claim(from);
    this.edges.set(from, new Edge(from, to));
    return this;
  }

  addConditionalEdges(from, router, paths) {
    this.#claim(from);
    this.edges.set(from, new ConditionalEdge(from, router, paths));
    return this;
  }

  setEntryPoint(name) {
    return this.addEdge(START, name);
  }

  #claim(from) {
    if (this.edges.has(from)) throw new GraphError(`${from} already has an outgoing edge`);
  }

  compile(opts = {}) {
    const known = name => name === END || this.nodes.has(name);
    if (!this.edges.has(START)) throw new GraphError('the graph has no entry point');
    for (const [from, edge] of this.edges) {
      if (from !== START && !this.nodes.has(from)) throw new GraphError(`edge from unknown node ${from}`);
      for (const to of edge.targets()) {
        if (!known(to)) throw new GraphError(`edge ${from} → ${to} points at an unknown node`);
      }
    }
    for (const name of this.nodes.keys()) {
      if (!this.edges.has(name)) throw new GraphError(`node ${name} has no outgoing edge`);
    }
    const reached = new Set();
    const queue = [START];
    while (queue.length) {
      const at = queue.shift();
      if (reached.has(at) || at === END) continue;
      reached.add(at);
      const edge = this.edges.get(at);
      if (edge) queue.push(...edge.targets());
    }
    const orphans = [...this.nodes.keys()].filter(n => !reached.has(n));
    if (orphans.length) throw new GraphError(`unreachable nodes: ${orphans.join(', ')}`);
    return new CompiledGraph(this, opts);
  }
}

class CompiledGraph {
  /**
   * @param {StateGraph} graph
   * @param {{ checkpointer?: { load?: Function, save?: Function }, recursionLimit?: number }} opts
   */
  constructor(graph, opts = {}) {
    this.nodes = new Map(graph.nodes);
    this.edges = new Map(graph.edges);
    this.checkpointer = opts.checkpointer || null;
    this.recursionLimit = opts.recursionLimit || 100;
    Object.freeze(this);
  }

  /**
   * Runs the graph from START until END. The state is mutated in place and
   * returned. If the state has a trace array, each visited node is appended.
   */
  async invoke(state) {
    if (this.checkpointer && this.checkpointer.load) await this.checkpointer.load(state);
    try {
      let at = this.edges.get(START).next(state);
      let steps = 0;
      while (at !== END) {
        if (++steps > this.recursionLimit) throw new GraphError(`recursion limit ${this.recursionLimit} reached at ${at}`);
        const node = this.nodes.get(at);
        if (!node) throw new GraphError(`no node named ${at}`);
        const started = Date.now();
        const patch = await node.run(state);
        if (patch && typeof patch === 'object') {
          if (typeof state.update === 'function') state.update(patch);
          else Object.assign(state, patch);
        }
        if (Array.isArray(state.trace)) state.trace.push({ node: at, ms: Date.now() - started });
        at = this.edges.get(at).next(state);
      }
      return state;
    } finally {
      if (this.checkpointer && this.checkpointer.save) await this.checkpointer.save(state);
    }
  }

  /** Plain description of the structure, for logs and the API. */
  describe() {
    const nodes = [...this.nodes.values()].map(n => ({ name: n.name, description: n.description }));
    const edges = [];
    for (const [from, edge] of this.edges) {
      if (edge instanceof ConditionalEdge) {
        if (edge.paths) for (const [when, to] of Object.entries(edge.paths)) edges.push({ from, to, when });
      } else {
        edges.push({ from, to: edge.to });
      }
    }
    return { nodes, edges };
  }

  toMermaid() {
    const id = name => (name === START ? 'START' : name === END ? 'END' : name.replace(/[^\w]/g, '_'));
    const lines = ['flowchart TD'];
    for (const { from, to, when } of this.describe().edges) {
      lines.push(when ? `  ${id(from)} -->|${when}| ${id(to)}` : `  ${id(from)} --> ${id(to)}`);
    }
    return lines.join('\n');
  }
}

module.exports = { START, END, GraphError, Node, FunctionNode, Edge, ConditionalEdge, StateGraph, CompiledGraph };
