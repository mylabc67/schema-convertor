const _ = require('lodash');
const fs = require('fs');
const url = require('url');
const http = require('http');
const https = require('https');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const swaggerParser = require('swagger-parser');
const swaggerTools = require('swagger-tools').specs.v2; // Validate using the latest Swagger 2.x specification
const Logger = require('./logger');
const log = Logger('GetSchemaApiPlugin');
const LINE_BREAK = '\n';

function logProblems (type, problems, color) {
	return problems.length && log([
		LINE_BREAK,
		`Swagger Schema ${type} (${problems.length})`,
		'--------------------------------------------------',
		formatProblems(problems),
		LINE_BREAK,
	].join(LINE_BREAK), color);
}

function formatProblems (problems) {
	return problems
		.map((problem) => [
			`#/${problem.path.join('/')}: ${problem.message}`,
			JSON.stringify(problem),
			LINE_BREAK,
		].join(LINE_BREAK))
		.join(LINE_BREAK);
}

function formatJsonSchemas (swaggerObject) {
	function reducePaths (newPathCollection, currentPath) {
		const pathMethods = swaggerObject.paths[currentPath] || {};
		const pathSchemas = Object.keys(pathMethods)
			.reduce((newMethodCollection, currentMethod) => {
				const methodParameters = (pathMethods[currentMethod].parameters || [])
					.filter(function filterBodyParameter (parameter) {
						return parameter.in === 'body';
					})[0] || {};
				const methodResponses = pathMethods[currentMethod].responses || {};
				const methodSchemas = {
					request: methodParameters.schema,
					responses: Object.keys(methodResponses)
						.reduce(function reduceMethods (newResponsesCollection, currentResponse) {
							const responseSchema = methodResponses[currentResponse].schema || {};

							// eslint-disable-next-line immutable/no-mutation
							newResponsesCollection[currentResponse] = responseSchema;

							return newResponsesCollection;
						}, {}),
				};

				// eslint-disable-next-line immutable/no-mutation
				newMethodCollection[currentMethod] = methodSchemas;

				return newMethodCollection;
			}, {});

		// eslint-disable-next-line immutable/no-mutation
		newPathCollection[currentPath] = pathSchemas;

		return newPathCollection;
	}

	const swaggerPaths = Object.keys(swaggerObject.paths).reduce(reducePaths, {});

	return JSON.stringify(swaggerPaths, null, 4);
}

function normalizeName (id) {
	return id.replace(/\.|\-|\{|\}/g, '_');
};

function getPathToMethodName (m, path) {
	if (path === '/' || path === '') {
		return m;
	}

	// clean url path for requests ending with '/'
	const cleanPath = path.replace(/\/$/, '');

	let segments = cleanPath.split('/').slice(1);
	segments = _.transform(segments, (result, segment) => {
		if (segment[0] === '{' && segment[segment.length - 1] === '}') {
			// eslint-disable-next-line no-param-reassign, prefer-template
			segment = 'by' + segment[1].toUpperCase() + segment.substring(2, segment.length - 1);
		}

		result.push(segment);
	});

	const result = _.camelCase(segments.join('-'));

	return m.toLowerCase() + result[0].toUpperCase() + result.substring(1);
};

function getViewForSwagger2 (swagger, className) {
	const methods = [];
	const authorizedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'COPY', 'HEAD', 'OPTIONS', 'LINK', 'UNLIK', 'PURGE', 'LOCK', 'UNLOCK', 'PROPFIND'];
	const data = {
		description: swagger.info.description,
		isSecure: swagger.securityDefinitions !== undefined,
		className,
		domain: (swagger.schemes && swagger.schemes.length > 0 && swagger.host && swagger.basePath)
			? `${swagger.schemes[0]}://${swagger.host}${swagger.basePath.replace(/\/+$/g, '')}`
			: '',
		methods: [],
		definitions: [],
	};

	_.forEach(swagger.paths, (api, path) => {
		let globalParams = [];

		/**
		 * @param {Object} op - meta data for the request
		 * @param {string} m - HTTP method name - eg: 'get', 'post', 'put', 'delete'
		 */
		_.forEach(api, (op, m) => {
			if (m.toLowerCase() === 'parameters') {
				globalParams = op;
			}
		});

		_.forEach(api, (op, m) => {
			const M = m.toUpperCase();

			if (M === '' || authorizedMethods.indexOf(M) === -1) {
				return;
			}

			const secureTypes = [];

			if (swagger.securityDefinitions !== undefined || op.security !== undefined) {
				const mergedSecurity = _.merge([], swagger.security, op.security)
					.map((security) => Object.keys(security));

				if (swagger.securityDefinitions) {
					for (const sk in swagger.securityDefinitions) {
						if (mergedSecurity.join(',').indexOf(sk) !== -1) {
							secureTypes.push(swagger.securityDefinitions[sk].type);
						}
					}
				}
			}

			let methodName = op.operationId
				? normalizeName(op.operationId)
				: getPathToMethodName(m, path);

			// Make sure the method name is unique
			if (methods.indexOf(methodName) !== -1) {
				let i = 1;

				while (true) {
					if (methods.indexOf(`${methodName}_${i}`) !== -1) {
						i++;
					}
					else {
						methodName = `${methodName}_${i}`;
						break;
					}
				}
			}

			methods.push(methodName);

			const method = {
				path,
				className,
				methodName,
				method: M,
				isGET: M === 'GET',
				isPOST: M === 'POST',
				summary: op.description || op.summary,
				externalDocs: op.externalDocs,
				isSecure: swagger.security !== undefined || op.security !== undefined,
				isSecureToken: secureTypes.indexOf('oauth2') !== -1,
				isSecureApiKey: secureTypes.indexOf('apiKey') !== -1,
				isSecureBasic: secureTypes.indexOf('basic') !== -1,
				parameters: [],
				headers: [],
			};

			if (method.isSecure && method.isSecureToken) {
				// eslint-disable-next-line immutable/no-mutation
				data.isSecureToken = method.isSecureToken;
			}

			if (method.isSecure && method.isSecureApiKey) {
				// eslint-disable-next-line immutable/no-mutation
				data.isSecureApiKey = method.isSecureApiKey;
			}

			if (method.isSecure && method.isSecureBasic) {
				// eslint-disable-next-line immutable/no-mutation
				data.isSecureBasic = method.isSecureBasic;
			}

			const produces = op.produces || swagger.produces;

			if (produces) {
				method.headers.push({
				  name: 'Accept',
				  value: `'${produces.map((value) => value).join(', ')}'`,
				});
			}

			const consumes = op.consumes || swagger.consumes;

			if (consumes) {
				method.headers.push({name: 'Content-Type', value: `'${consumes}'` });
			}

			let params = [];

			if (_.isArray(op.parameters)) {
				params = op.parameters;
			}
			params = params.concat(globalParams);
			_.forEach(params, (parameter) => {
				//Ignore parameters which contain the x-exclude-from-bindings extension
				if (parameter['x-exclude-from-bindings'] === true) {
					return;
				}

				// Ignore headers which are injected by proxies & app servers
				// eg: https://cloud.google.com/appengine/docs/go/requests#Go_Request_headers
				if (parameter['x-proxy-header']) {
					return;
				}

				if (_.isString(parameter.$ref)) {
					const segments = parameter.$ref.split('/');
					// eslint-disable-next-line no-param-reassign
					parameter = swagger.parameters[segments.length === 1 ? segments[0] : segments[2] ];
				}

				/* eslint-disable immutable/no-mutation */
				parameter.camelCaseName = _.camelCase(parameter.name);

				if (parameter.enum && parameter.enum.length === 1) {
					parameter.isSingleton = true;
					parameter.singleton = parameter.enum[0];
				}

				if (parameter.in === 'body') {
					parameter.isBodyParameter = true;
				}
				else if (parameter.in === 'path') {
					parameter.isPathParameter = true;
				}
				else if (parameter.in === 'query') {
					if (parameter['x-name-pattern']) {
						parameter.isPatternType = true;
						parameter.pattern = parameter['x-name-pattern'];
					}
					parameter.isQueryParameter = true;
				}
				else if (parameter.in === 'header') {
					parameter.isHeaderParameter = true;
				}
				else if (parameter.in === 'formData') {
					parameter.isFormParameter = true;
				}

				// parameter.tsType = ts.convertType(parameter);
				parameter.cardinality = parameter.required ? '' : '?';
				method.parameters.push(parameter);
				/* eslint-enable immutable/no-mutation */
			});

			data.methods.push(method);
		});
	});

	_.forEach(swagger.definitions, (definition, name) => {
		data.definitions.push({
			name,
			description: definition.description,
			// tsType: ts.convertType(definition, swagger)
		});
	});

	return data;
};

// eslint-disable-next-line immutable/no-mutation
module.exports = class GetSchemaApiPlugin {
	constructor (options = {}) {
		/* eslint-disable immutable/no-mutation */
		this.hasRunForThisBuild = false;
		this.src = options.src;
		this.dest = options.dest;
		this.docs = options.docs;
		this.apiEndpoint = options.apiEndpoint;
		this.generateDocumentation = this.generateDocumentation(this);
		this.generateApi = this.generateApi.bind(this);
		this.generateApiClass = this.generateApiClass.bind(this);
		this.generateApiMethod = this.generateApiMethod.bind(this);
		/* eslint-enable immutable/no-mutation */
	}

	apply (compiler) {
		compiler.plugin('before-compile', this.execute);
	}

	execute (compilation, callback = () => {}) {
		if (this.hasRunForThisBuild) {
			callback();
			return;
		}

		// We only need to generate the enums file once for every build.
		// eslint-disable-next-line immutable/no-mutation
		this.hasRunForThisBuild = true;

		const readSchema = this.apiEndpoint
			? this.readRemoteSchema(this.apiEndpoint)
			: this.readStaticSchema(this.src);

		return readSchema
			.then(this.validateSchemaFirstPass)
			.then(this.validateSchemaSecondPass)
			.then(this.generateDocumentation)
			.then(this.generateApi)
			.catch(log);
	}

	readStaticSchema (filePath) {
		return new Promise((resolve, reject) => {
			try {
				const fileContents = JSON.parse(fs.readFileSync(filePath, 'utf8'));
				return resolve(fileContents);
			}
			catch (err) {
				return reject('Could not read file.');
			}
		});
	}

	readRemoteSchema(apiEndpoint) {
		return new Promise((resolve, reject) => {
			const apiUrl = url.parse(apiEndpoint);
			const client = (apiUrl.protocol === 'https:') ? https : http;
			const req = client.get({
				hostname: apiUrl.hostname,
				port: apiUrl.port,
				path: '/schema/v1',
				headers: {},
			}, (response) => {
				const { statusCode } = response;
				const contentType = response.headers['content-type'];
				let error;

				if (statusCode !== 200) {
					error = new Error([
						'Swagger Schema Request Failed.',
						`Status Code: ${statusCode}`,
					].join('\n'));
				}
				else if (!/^application\/json/.test(contentType)) {
					error = new Error([
						'Invalid content-type.',
						`Expected application/json but received ${contentType}`,
					].join('\n'));
				}

				if (error) {
					log(error.message, 'red');
					// consume response data to free up memory
					response.resume();
					return;
				}

				response.setEncoding('utf8');

				let rawData = '';

				response.on('data', (chunk) => rawData += chunk);
				response.on('end', () => {
					try {
						const parsedData = JSON.parse(rawData);
						resolve(parsedData);
					}
					catch (error) {
						log(error.message, 'red');
						reject();
					}
				});
			});

			req.on('error', (error) => {
				log(`problem with request: ${error.message}`, 'red');
				reject();
			});
			req.end();
		});
	}

	validateSchemaFirstPass (schemaContents) {
		return new Promise((resolve, reject) => {
			// Load swagger main file resolving *only* external $refs and validate schema (1st pass).
			// We keep internal $refs intact for more accurate results in 2nd validation pass bellow.
			swaggerParser.dereference(
				schemaContents,
				{ $refs: { internal: false } },
				(error, swaggerObject) => error
					? reject(error)
					: resolve(swaggerObject)
			);
		});
	}

	validateSchemaSecondPass (swaggerObject) {
		return new Promise((resolve, reject) => {
			// Re-Validate resulting schema using different project (2nd pass),
			// the reason being that this validator gives different
			// (and more accurate) resutls.
			swaggerTools.validate(swaggerObject, (error, result) => {
				if (error) {
					return reject(error);
				}

				if ( typeof result !== 'undefined' ) {
					logProblems('Errors', result.errors, 'red');
					logProblems('Warnings', result.warnings, 'yellow');

					if (result.errors.length) {
						return reject('The Swagger schema is invalid');
					}
				}

				// Now that we know for sure the schema is 100% valid,
				// continue by dereferencing internal $refs as well.
				swaggerParser.dereference(
					swaggerObject,
					{},
					(error, swaggerObject) => error
						? reject(error)
						: resolve(swaggerObject)
				);
			});
		});
	}

	generateDocumentation (swaggerObject) {
		const docsConfig = {
			// `specFile` will only work for the static file...
			specFile: this.src,
			// ...we need to build support in `spectacle` for accepting the schema itself.
			// (that means contributing to the original Git project)
			// specObject: swaggerObject,
			targetDir: this.docs,
		};

		return new Promise((resolve, reject) => {
			const hasTargetDir = typeof docsConfig.targetDir === 'string' && docsConfig.targetDir.length > 0;

			if (hasTargetDir) {
				// Ideally we'd like to call `spectacle` programatically, but stupid GrunJS
				// (used internally by `spectacle`) is a singleton, so we can't run multiple
				// processes at the same time, hence we are using `exec` to span multiple instances.
				// // spectacle(docsConfig).then(() => resolve(swaggerObject));
				const command = `spectacle --target-dir ${docsConfig.targetDir} ${docsConfig.specFile}`;

				exec(command)
					.catch(reject)
					.then(() => resolve(swaggerObject));
			}
			else {
				resolve(swaggerObject);
			}
		});
	}

	generateApi (swaggerObject) {
		return new Promise((resolve, reject) => {
			const hasDestination = typeof this.dest === 'string' && this.dest.length > 0;

			if (hasDestination) {
				log(`Writing file ${this.dest}`, 'cyan');
				fs.writeFile(this.dest, this.generateApiClass(swaggerObject), (err) => {
					if (err) reject(err);
					else resolve();
				});
			}
			else {
				resolve();
			}
		});
	}

	generateApiClass (swaggerObject) {
		const swaggerViewData = getViewForSwagger2(swaggerObject, 'API');
		const generateApiMethod = this.generateApiMethod;

		return (`
// WARNING: This file is GENERATED AUTOMATICALLY by the build system.
// Do not update this file by hand, your changes will be lost in the next UI build.

import _ from 'lodash';
import ajax from './ajax';
import { APIError } from '../errors';

const basePath = '${swaggerObject.basePath || ''}';
const schemas = ${formatJsonSchemas(swaggerObject)};
const ${swaggerViewData.className} = {};
${swaggerViewData.isSecure && (`
/**
 * Set Token
 * @method
 * @name ${swaggerViewData.className}#setToken
 * @param {string} value - token's value
 * @param {string} headerOrQueryName - the header or query name to send the token at
 * @param {boolean} isQuery - true if send the token as query param, otherwise, send as header param
 *
 */
${swaggerViewData.className}.setToken = function(value, headerOrQueryName, isQuery) {
	this.token.value = value;
	this.token.headerOrQueryName = headerOrQueryName;
	this.token.isQuery = isQuery;
};
`)}
${swaggerViewData.methods.map(generateApiMethod).join(LINE_BREAK)}

if (process.env.NODE_ENV !== 'production') {
	// In development mode we expose it to the global object to ease debugging.
	// We are exporting under a different name to avoid having the global object
	// fulfil the demand for this object inside modules that failed to import it
	// properly, which could lead to bugs in production.
	window._${swaggerViewData.className} = ${swaggerViewData.className};
}

export default ${swaggerViewData.className};
`).replace(/\t/g, '    ');
	}

	generateApiMethod (method) {
		/* eslint-disable indent */
		return (
`/**
 * ${method.summary || ''}
 * @method
 * @name ${method.className}#${method.methodName}
${method.parameters.map((parameter) => !parameter.isSingleton
		&& ` * @param {${parameter.type || ''}} ${parameter.camelCaseName} - ${parameter.description}`
	).filter(Boolean).join(LINE_BREAK)
}
 *
 */
${method.className}.${method.methodName} = function(parameters = {}) {
	const skipIndicator = parameters.skipIndicator;

	// TODO: Remove these invalid filters from the request parameters.
	parameters = _.omit(parameters, ['loadingPageNumber', 'saveSelection', 'skipIndicator']);

	const ${method.className}${method.methodName}Promise = new Promise(function(resolve, reject) {
		var path = '${method.path}';
		var schema = schemas[path];

		var body;
		var queryParameters = {};
		var headers = {};
		var form = {};

		if (process.env.NODE_ENV !== 'production') {
			// Debug accepted parameters
			const acceptedParams = [
${method.parameters.map((parameter) => (
	!parameter.isSingleton ? `				'${parameter.camelCaseName}',` : ''
)).join(LINE_BREAK)}
			];
			const invalidParams = Object.keys(parameters).reduce((results, parameter) => {
				if (acceptedParams.indexOf(parameter) === -1) {
					results.push(parameter);
				}

				return results;
			}, []);

			if (invalidParams.length) {
				console.warn([
					\`The request ${method.className}.${method.methodName}(${'${JSON.stringify(parameters)}'})\`,
					\`call to ${method.path} is attempting to pass a the parameter${'${invalidParams.length === 1 ? \'\' : \'s\'}'}: ${'${invalidParams.join(\', \')}'},\`,
					\`which ${'${invalidParams.length === 1 ? \'is\' : \'are\'}'} not accepted by the ${method.className}.${method.methodName} method.\`,
				].join(' '));
			}
		}

${method.parameters.reduce((results, parameter) => results.concat(
/* eslint-disable prefer-template */
	parameter.isQueryParameter
		? parameter.isSingleton
			? `queryParameters.${parameter.name} = '${parameter.singleton}';`
			: parameter.isPatternType
				? `Object.keys(parameters).forEach(function(parameterName) {
					if (new RegExp('${parameter.pattern}').test(parameterName)) {
						queryParameters[parameterName] = parameters[parameterName];
					}
				});`
				: `		if (parameters.${parameter.camelCaseName} !== undefined) {
			queryParameters.${parameter.name} = parameters.${parameter.camelCaseName};
		}`
	: parameter.isPathParameter
		? `path = path.replace('{${parameter.name}}', parameters.${parameter.camelCaseName});`
	: parameter.isHeaderParameter
		? parameter.isSingleton
			? `headers.${parameter.name} = '${parameter.singleton}';`
			: `		if (parameters.${parameter.camelCaseName} !== undefined) {
			headers.${parameter.name} = parameters.${parameter.camelCaseName};
		}`
	: parameter.isBodyParameter
		? `		if (parameters.${parameter.camelCaseName} !== undefined) {
			body = parameters.${parameter.camelCaseName};
		}`
	: parameter.isFormParameter
		&& parameter.isSingleton
			? `form.${parameter.name} = '${parameter.singleton}';`
			: `		if (parameters.${parameter.camelCaseName} !== undefined) {
			form.${parameter.name} = parameters.${parameter.camelCaseName};
		}`
).concat(
	parameter.required
		&& `		if (parameters.${parameter.camelCaseName} === undefined) {
			return reject(new APIError('The ${method.className}.${method.methodName}(' + JSON.stringify(parameters) + ') call to ${method.path} is missing required ${parameter.type || ''} parameter: ${parameter.camelCaseName} (${parameter.description || ''}).'));
		}`
/* eslint-enable prefer-template */
), []).filter(Boolean).join(`${LINE_BREAK}${LINE_BREAK}`)}

		var req = {
			method: '${method.method}',
			url: basePath + path,
			headers: headers,
			body: body,
			path: path,
			schema: schema,
			skipIndicator: skipIndicator,
		};

		queryParameters = Object.keys(queryParameters)
			.reduce(function(queryString, parameterName) {
				var qs = encodeURIComponent(parameterName) + '=' + encodeURIComponent(queryParameters[parameterName]);
				queryString.push(qs);
				return queryString;
			}, []).join('&');

		if (queryParameters.length) {
			req.url += '?' + queryParameters;
		}

		if (Object.keys(form).length > 0) {
			req.form = form;
		}

		if (typeof req.body === 'object') {
			req.headers['Content-Type'] = 'application/json;charset=utf-8';
			req.json = true;
		}

		ajax(req).then(resolve).catch(reject);
	});

	return ${method.className}${method.methodName}Promise
	//.catch(console.log.bind(console));
};`).replace(/\t/g, '    ');
		/* eslint-enable indent */
	}
};
