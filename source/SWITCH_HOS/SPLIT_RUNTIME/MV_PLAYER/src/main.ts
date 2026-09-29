import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.70.0').catch(reportFatal);

