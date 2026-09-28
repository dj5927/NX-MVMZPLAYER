import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.49.0').catch(reportFatal);

