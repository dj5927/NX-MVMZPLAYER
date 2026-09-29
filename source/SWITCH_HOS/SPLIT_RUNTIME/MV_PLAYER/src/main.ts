import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.73.0').catch(reportFatal);

