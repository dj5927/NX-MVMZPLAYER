import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.45.0').catch(reportFatal);

