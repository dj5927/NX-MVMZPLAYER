import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.61.0').catch(reportFatal);

