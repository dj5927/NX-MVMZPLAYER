import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.58.0').catch(reportFatal);

