import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.57.0').catch(reportFatal);

