import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.59.0').catch(reportFatal);

