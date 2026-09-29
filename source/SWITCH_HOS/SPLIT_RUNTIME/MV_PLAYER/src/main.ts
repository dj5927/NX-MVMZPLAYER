import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.71.0').catch(reportFatal);

