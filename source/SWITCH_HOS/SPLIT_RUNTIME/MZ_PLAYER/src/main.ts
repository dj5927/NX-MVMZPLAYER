import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.55.0').catch(reportFatal);

