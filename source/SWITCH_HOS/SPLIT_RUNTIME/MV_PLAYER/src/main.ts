import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.65.0').catch(reportFatal);

