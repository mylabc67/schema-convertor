const chalk = require('chalk');
const LINE_BREAK = '\n';

// eslint-disable-next-line immutable/no-mutation
module.exports = function Logger (loggerName) {
	return function log (message = [], color = 'yellow') {
		const chalkColor = chalk[color];
		const loggerTitle = loggerName ? `[${loggerName}] ` : '';
		const logMessage = []
			.concat(message)
			.map((msg) => `${loggerTitle}${msg}`)
			.join(LINE_BREAK);

		// eslint-disable-next-line no-console
		return console.log( chalkColor(logMessage) );
	};
};
