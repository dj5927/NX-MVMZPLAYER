import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.60.0').catch(reportFatal);

