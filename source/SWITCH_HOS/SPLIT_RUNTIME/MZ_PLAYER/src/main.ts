import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.48.0').catch(reportFatal);

