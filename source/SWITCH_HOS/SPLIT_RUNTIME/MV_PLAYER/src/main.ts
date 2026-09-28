import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.49.0').catch(reportFatal);

