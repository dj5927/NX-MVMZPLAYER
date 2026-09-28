import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.45.0').catch(reportFatal);

