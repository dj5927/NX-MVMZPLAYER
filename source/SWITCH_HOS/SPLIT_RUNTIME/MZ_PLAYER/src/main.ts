import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.54.0').catch(reportFatal);

