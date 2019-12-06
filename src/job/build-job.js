import EventEmitter from 'events';
import path from 'path';
import defaultsDeep from 'lodash.defaultsdeep';

import { validate, defaults } from './options';
import HookManager from '../hook-api/manager';
import { loadProjectOptions, processStats, registerHooks } from '../utils';

const defaultJsonFields = [
	'id',
	'options',
	'name',
	'projectPath',
	'projectType',
	'platform',
	'state',
	'history'
];
const jsonTemplateConfig = {
	default: defaultJsonFields,
	detail: [
		...defaultJsonFields,
		'deployType',
		'progress',
		'stats',
		'output',
		'tiSymbols'
	]
};

/**
 * Representation of a Webpack build job.
 *
 * Uses webpack's NodeJS api to run a webpack compilation
 */
export default class BuildJob extends EventEmitter {
	constructor(id, options) {
		super();

		this._state = BuildJob.STATE_STOPPED;
		this.id = id;
		this.pid = null;
		this.output = '';
		this.history = [];
		this.isStarting = false;
		this.progress = {
			progress: 0
		};
		this.tiSymbols = {};

		this.setOptions(options);

		const hookManager = new HookManager();
		registerHooks(hookManager);
		const projectOptions = loadProjectOptions(this.projectPath, {
			platform: this.platform,
			buildTarget: this.options.buildTarget,
			sdkPath: this.options.sdkPath,
			watch: true
		});
		this.hooks = hookManager.createProjectHookContext(this.projectPath, projectOptions);
		this.hooks.on('change', () => {
			this.restart();
		});
	}

	static get STATE_BUILDING() {
		return 'building';
	}

	static get STATE_READY() {
		return 'ready';
	}

	static get STATE_STOPPED() {
		return 'stopped';
	}

	static get STATE_ERROR() {
		return 'error';
	}

	get state() {
		return this._state;
	}

	set state(newState) {
		if (this._state === newState) {
			return;
		}

		this._state = newState;
		this.emit('state', this, this._state);
	}

	setOptions(newOptions) {
		newOptions = defaultsDeep(newOptions, this.options);
		this.options = defaultsDeep(newOptions, defaults());
		validate(this.options);

		const {
			projectPath,
			projectType,
			platform,
			deployType
		} = this.options;
		this.name = projectPath.split('/').pop();
		this.projectPath = projectPath;
		this.projectType = projectType;
		this.platform = platform;
		this.deployType = deployType;
	}

	async start() {
		if (this.pid !== null || this.isStarting) {
			return;
		}

		this.isStarting = true;
		this.cleanupJobData();
		let taskName = 'build';
		// @TODO switch to serve task for non-production builds

		const args = [
			path.resolve(__dirname, '..', 'tasks', `${taskName}.js`),
			'--project', this.projectPath,
			'--platform', this.platform,
			'--target', this.options.buildTarget,
			'--sdk', this.options.sdkPath,
		];

		let watch = this.deployType !== 'production';
		if (typeof this.options.watch !== 'undefined') {
			watch = this.options.watch;
		}
		if (watch) {
			args.push('--watch');
		}

		this.output = `\u001b[90m$ appcd-plugin-webpack ${taskName} ${args.slice(1).join(' ')}\u001b[0m\n\n`;

		const startTimeout = setTimeout(() => {
			throw new Error('Webpack build failed to spawn within 5 sec.');
		}, 5000);

		const { response } = await appcd.call('/appcd/subprocess/spawn/node', {
			data: {
				args,
				ipc: true,
				env: Object.assign({}, process.env, {
					NODE_ENV: this.deployType
				})
			}
		});
		response.on('data', data => {
			switch (data.type) {
				case 'spawn': {
					clearTimeout(startTimeout);
					this.pid = data.pid;
					this.state = BuildJob.STATE_BUILDING;
					this.isStarting = false;
					return Promise.resolve();
				}
				case 'stdout': {
					this.output += data.output;
					this.emit('output', data.output);
					break;
				}
				case 'stderr': {
					this.output += data.output;
					this.emit('output', data.output);
					break;
				}
				case 'ipc': {
					this.processIpcMessage(data.msg);
					break;
				}
				case 'exit': {
					this.pid = null;
					if (data.code !== null && data.code !== 0) {
						this.state = BuildJob.STATE_ERROR;
					} else {
						this.state = BuildJob.STATE_STOPPED;
					}
				}
			}
		});
	}

	/**
	 * Stops the Webpack build task.
	 *
	 * Note that we don't set the state here as it will be set when the child
	 * process' `exit` event is received. This will trigger a state change here
	 * which we use to resolve the returned promise.
	 */
	async stop() {
		if (typeof this.pid !== 'number') {
			return;
		}

		return new Promise((resolve, reject) => {
			const killTimeout = setTimeout(() => {
				this.off('state', handler);
				reject(new Error('Kill timeout of 5sec exceeded.'));
			}, 5000);
			const handler = (job, state) => {
				if (state === BuildJob.STATE_STOPPED) {
					this.off('state', handler);
					clearTimeout(killTimeout);
					this.pid = null;
					this.cleanupJobData();
					resolve();
				}
			};
			this.on('state', handler);

			appcd.call(`/appcd/subprocess/kill/${this.pid}`);
		});
	}

	/**
	 * Restarts the Webpack build task, but only if it was prevously running.
	 */
	async restart() {
		if (this.pid === null) {
			return;
		}

		await this.stop();
		return this.start();
	}

	processIpcMessage(message) {
		switch (message.type) {
			case 'dashboard': {
				if (message.data.type === 'done') {
					this.storeBuildResult(message.data.data);
				} else if (message.data.type === 'progress') {
					this.updateBuildProgress(message.data.data);
				}
				break;
			}
			case 'state': {
				if (message.data === 'ready') {
					this.state = BuildJob.STATE_READY;
				} else if (message.data === 'error') {
					this.state = BuildJob.STATE_ERROR;
				} else if (message.data === 'compiling') {
					this.state = BuildJob.STATE_BUILDING;
				}
				break;
			}
			case 'invalid': {
				this.invalidationReason = message.data;
				break;
			}
			case 'api-usage': {
				for (const usageInfo of message.data) {
					const { file, symbols = [], removed = false } = usageInfo;
					if (removed) {
						delete this.tiSymbols[file];
					} else {
						this.tiSymbols[file] = symbols;
					}
				}
				this.emit('api-usage', this.tiSymbols);
			}
		}
	}

	updateBuildProgress(data) {
		this.progress = data;
		this.emit('progress', data);
	}

	storeBuildResult(context) {
		this.stats = processStats(context.stats);

		this.history.unshift({
			invalid: this.invalidationReason,
			errors: (context.errors || []).length,
			warnings: (context.warnings || []).length,
			progress: context.progress,
			message: context.message,
			timestamp: new Date()
		});
		if (this.history.length > 10) {
			this.history.pop();
		}
		this.invalidationReason = null;

		this.emit('done', this);
	}

	toJson(template = 'default') {
		const jsonConfig = jsonTemplateConfig[template];
		const data  = {};
		for (const propertyName of jsonConfig) {
			data[propertyName] = this[propertyName];
		}
		return data;
	}

	cleanupJobData() {
		this.stats = null;
		this.progress = {
			progress: 0
		};
		this.tiSymbols = {};
		this.output = '';
	}
}